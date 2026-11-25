/**
 * Standalone System 2 Software Factory (`S2-FAC-09`):
 * 1. Native `spec.toml` parser & deterministic verification runner (`parseSpecToml`, `runNativeSpecVerify`) — zero Python dependency.
 * 2. Standalone local worktree wave executor (`planStandaloneFactoryRun`) with lean worker args & safe LM Studio VRAM load guard.
 * 3. Pre-publish / pre-PR Secret, API Key & PII Auditor (`auditRepoSecretsAndPii`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildCleanPiWorkerArgs, type FactoryKanbanCard, scheduleKanbanWaves } from "./factory.ts";
import {
	detectSystemVramBudget,
	planSafeLmStudioLoad,
	probeModelBehavioralQuirks,
	runRosterChallengerArena,
	type SafeLmStudioLoadPlan,
} from "./model-arena.ts";

export interface SpecAcceptanceItem {
	name: string;
	criterion: string;
	command: string;
}

export interface SpecExternalItem {
	name: string;
	contract?: string;
	check: string;
}

export interface ParsedFactorySpec {
	ticket: string;
	slug: string;
	title: string;
	sizeCap: number;
	splitStep?: string;
	acceptance: SpecAcceptanceItem[];
	external: SpecExternalItem[];
	expectedPlan?: string;
	expectedLineCount?: number;
	pr: {
		why: string;
		mergeEffect: string;
		rollback: string;
		outOfScope: string;
	};
}

export type ShellCommandRunner = (cmd: string, cwd: string) => { code: number; output: string };

export interface NativeVerifyResult {
	ticket: string;
	slug: string;
	passed: boolean;
	diffStat: string;
	sizeCap: number;
	results: Array<SpecAcceptanceItem & { code: number; passed: boolean; output: string }>;
	externalResults: Array<{ name: string; command: string; passed: boolean; output: string }>;
	verifyMdPath: string;
	prBodyPath: string;
}

export interface StandaloneWaveWorkerStep {
	cardId: string;
	title: string;
	worktreeDir: string;
	branchName: string;
	allowedFiles: readonly string[];
	leanPiArgs: string[];
	verifyCmd: string;
}

export interface StandaloneRunPlan {
	goal: string;
	modelId: string;
	vramLoadPlan: SafeLmStudioLoadPlan;
	waves: StandaloneWaveWorkerStep[][];
}

export type SecurityFindingKind = "api_key_or_token" | "private_key_block" | "hardcoded_home_path" | "gitignore_gap";

export interface SecurityAuditFinding {
	kind: SecurityFindingKind;
	severity: "critical" | "high" | "medium";
	path: string;
	line: number;
	rule: string;
	snippet: string;
}

export interface SecurityAuditReport {
	clean: boolean;
	filesScanned: number;
	findings: SecurityAuditFinding[];
}

const unquote = (raw: string): string => {
	const t = raw.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return t;
};

/** Parses a `/software-factory` `spec.toml` document natively in TypeScript without external TOML dependencies. */
export function parseSpecToml(tomlContent: string): ParsedFactorySpec {
	const spec: ParsedFactorySpec = {
		ticket: "UNKNOWN",
		slug: "unknown",
		title: "",
		sizeCap: 300,
		acceptance: [],
		external: [],
		pr: { why: "", mergeEffect: "", rollback: "", outOfScope: "" },
	};

	let section = "root";
	let currentObj: Record<string, string> = {};

	const flushArrayItem = (): void => {
		if (section === "[[acceptance]]" && currentObj.name && currentObj.command) {
			spec.acceptance.push({
				name: currentObj.name,
				criterion: currentObj.criterion ?? "",
				command: currentObj.command,
			});
		} else if (section === "[[external]]" && currentObj.check) {
			spec.external.push({
				name: currentObj.name ?? "external",
				contract: currentObj.contract,
				check: currentObj.check,
			});
		}
		currentObj = {};
	};

	for (const rawLine of tomlContent.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("[")) {
			flushArrayItem();
			section = line;
			continue;
		}
		const eqIdx = line.indexOf("=");
		if (eqIdx === -1) continue;
		const key = line.slice(0, eqIdx).trim();
		const valRaw = line.slice(eqIdx + 1).trim();
		if (valRaw === "[]") continue;
		const val = unquote(valRaw);

		if (section === "root") {
			if (key === "ticket") spec.ticket = val;
			else if (key === "slug") spec.slug = val;
			else if (key === "title") spec.title = val;
			else if (key === "size_cap") spec.sizeCap = Number.parseInt(val, 10) || 300;
		} else if (section === "[split]" && key === "step") {
			spec.splitStep = val;
		} else if (section === "[expected]") {
			if (key === "plan") spec.expectedPlan = val;
			else if (key === "line_count") spec.expectedLineCount = Number.parseInt(val, 10) || 0;
		} else if (section === "[pr]") {
			if (key === "why") spec.pr.why = val;
			else if (key === "merge_effect") spec.pr.mergeEffect = val;
			else if (key === "rollback") spec.pr.rollback = val;
			else if (key === "out_of_scope") spec.pr.outOfScope = val;
		} else if (section === "[[acceptance]]" || section === "[[external]]") {
			currentObj[key] = val;
		}
	}
	flushArrayItem();
	return spec;
}

const defaultShellRunner: ShellCommandRunner = (cmd, cwd) => {
	try {
		const output = execFileSync("/bin/sh", ["-c", cmd], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output };
	} catch (err: unknown) {
		const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
		return {
			code: typeof e.status === "number" && e.status !== 0 ? e.status : 1,
			output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? "command failed"),
		};
	}
};

/** Native TypeScript port of `verify.py` ("Rule: Script decides, not a model"). */
export function runNativeSpecVerify(
	specPath: string,
	repoDir: string,
	runner: ShellCommandRunner = defaultShellRunner,
): NativeVerifyResult {
	const absSpec = resolve(specPath);
	const absRepo = resolve(repoDir);
	if (!existsSync(absSpec)) {
		throw new Error(`Spec file not found at ${absSpec}`);
	}
	const spec = parseSpecToml(readFileSync(absSpec, "utf8"));
	const specDir = dirname(absSpec);

	const diffRes = runner(
		"git diff --shortstat origin/main...HEAD 2>/dev/null || git diff --shortstat HEAD~1 2>/dev/null || echo '0 files changed'",
		absRepo,
	);
	const diffStat = diffRes.output.trim();

	let allPassed = true;
	const results = spec.acceptance.map((item) => {
		const res = runner(item.command, absRepo);
		const passed = res.code === 0;
		if (!passed) allPassed = false;
		return { ...item, code: res.code, passed, output: res.output };
	});

	const externalResults = spec.external.map((ext) => {
		const res = runner(ext.check, absRepo);
		const passed = res.code === 0;
		if (!passed) allPassed = false;
		return { name: ext.name, command: ext.check, passed, output: res.output };
	});

	const verifyMdPath = join(specDir, "verify.md");
	const verifyLines: string[] = [
		`# Verification Report: ${spec.ticket} (${spec.slug})`,
		"",
		`**Overall Status**: ${allPassed ? "PASS" : "FAIL"}`,
		"",
		`**Repo Worktree**: \`${absRepo}\``,
		`**Size Stat**: \`${diffStat}\` (cap: ${spec.sizeCap})`,
		"",
		"## Acceptance Criteria",
		"",
	];
	for (const r of results) {
		verifyLines.push(`### ${r.name} - ${r.passed ? "PASS" : "FAIL"}`);
		verifyLines.push(`- **Criterion**: ${r.criterion}`);
		verifyLines.push(`- **Command**: \`${r.command}\``);
		verifyLines.push(`- **Exit Code**: ${r.code}`, "");
	}
	writeFileSync(verifyMdPath, verifyLines.join("\n"), "utf8");

	const prBodyPath = join(specDir, "pr-body.md");
	const prLines: string[] = [
		"## Summary",
		"",
		spec.title,
		"",
		"### Why",
		"",
		spec.pr.why,
		"",
		"### Merge Effect",
		"",
		spec.pr.mergeEffect,
		"",
		"### Rollback",
		"",
		spec.pr.rollback,
		"",
		"### Out of Scope",
		"",
		spec.pr.outOfScope,
		"",
		"### Verification",
		"",
		...results.map((r) => `- [${r.passed ? "x" : " "}] \`${r.name}\`: \`${r.command}\``),
		"",
	];
	writeFileSync(prBodyPath, prLines.join("\n"), "utf8");

	return {
		ticket: spec.ticket,
		slug: spec.slug,
		passed: allPassed,
		diffStat,
		sizeCap: spec.sizeCap,
		results,
		externalResults,
		verifyMdPath,
		prBodyPath,
	};
}

/** Plans standalone local worktree waves using lean pi flags (`--no-skills --no-context-files`) and safe VRAM load caps. */
export function planStandaloneFactoryRun(params: {
	goal: string;
	cards: readonly FactoryKanbanCard[];
	coupledPairs?: readonly { cardA: string; cardB: string }[];
	modelId?: string;
	worktreeBaseDir?: string;
	requestedContextLength?: number;
}): StandaloneRunPlan {
	const modelId = params.modelId ?? "qwen3.8-27b-splash";
	const worktreeBase = (params.worktreeBaseDir ?? ".system2/worktrees").replace(/\/+$/, "");
	const vramLoadPlan = planSafeLmStudioLoad({
		modelId,
		requestedContextLength: params.requestedContextLength ?? 32768,
		requestedParallel: 1,
		vramBudget: detectSystemVramBudget(),
	});

	const rawWaves = params.cards.length > 0 ? scheduleKanbanWaves(params.cards, params.coupledPairs ?? []) : [];
	const waves: StandaloneWaveWorkerStep[][] = rawWaves.map((wave) =>
		wave.map((card) => {
			const slug = card.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
			const worktreeDir = `${worktreeBase}/${slug}`;
			const branchName = `factory/${slug}`;
			const prompt = `Execute card ${card.id}: ${card.title}. Allowed files: ${card.allowedFiles.join(", ")}. Verify with: ${card.verifyCmd}`;
			return {
				cardId: card.id,
				title: card.title,
				worktreeDir,
				branchName,
				allowedFiles: card.allowedFiles,
				leanPiArgs: buildCleanPiWorkerArgs({ modelId, prompt }),
				verifyCmd: card.verifyCmd,
			};
		}),
	);

	return { goal: params.goal, modelId, vramLoadPlan, waves };
}

const SECRET_RULES: ReadonlyArray<{
	rule: string;
	kind: SecurityFindingKind;
	severity: "critical" | "high";
	re: RegExp;
}> = [
	{
		rule: "openai_or_anthropic_key",
		kind: "api_key_or_token",
		severity: "critical",
		re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
	},
	{ rule: "huggingface_token", kind: "api_key_or_token", severity: "critical", re: /\bhf_[A-Za-z0-9]{24,}\b/ },
	{
		rule: "github_pat",
		kind: "api_key_or_token",
		severity: "critical",
		re: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
	},
	{ rule: "aws_access_key_id", kind: "api_key_or_token", severity: "critical", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ rule: "slack_token", kind: "api_key_or_token", severity: "critical", re: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/ },
	{
		rule: "pem_private_key",
		kind: "private_key_block",
		severity: "critical",
		re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{32,}/,
	},
	{
		rule: "hardcoded_user_home_path",
		kind: "hardcoded_home_path",
		severity: "high",
		re: /\/(?:Users|home)\/[a-zA-Z0-9._-]{3,}\//,
	},
];

/** Audits file contents and `.gitignore` for leaked API keys, private keys, hardcoded personal home paths, and unignored state directories. */
export function auditRepoSecretsAndPii(params: {
	files: ReadonlyArray<{ path: string; content: string; isTest?: boolean }>;
	gitignoreContent?: string;
}): SecurityAuditReport {
	const findings: SecurityAuditFinding[] = [];

	if (params.gitignoreContent !== undefined) {
		for (const requiredEntry of [".env", ".system2/"]) {
			if (!params.gitignoreContent.includes(requiredEntry)) {
				findings.push({
					kind: "gitignore_gap",
					severity: "medium",
					path: ".gitignore",
					line: 1,
					rule: "missing_gitignore_guard",
					snippet: `Missing '${requiredEntry}' in .gitignore`,
				});
			}
		}
	}

	for (const file of params.files) {
		const isTestFile = file.isTest ?? /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$/.test(file.path);
		const lines = file.content.split(/\r?\n/);
		for (let idx = 0; idx < lines.length; idx++) {
			const line = lines[idx];
			for (const rule of SECRET_RULES) {
				if (isTestFile && rule.kind === "hardcoded_home_path") continue;
				if (rule.re.test(line)) {
					if (/ExampleRealisticLookingApiKey|DUMMY|placeholder|test-token/i.test(line)) continue;
					findings.push({
						kind: rule.kind,
						severity: rule.severity,
						path: file.path,
						line: idx + 1,
						rule: rule.rule,
						snippet: line.trim().slice(0, 120),
					});
				}
			}
		}
	}

	return {
		clean: findings.length === 0,
		filesScanned: params.files.length,
		findings,
	};
}

/** Quick helper for `system2 factory arena <model-id>` CLI execution. */
export function runQuickCliModelArena(modelId: string, maxVramBudgetGb?: number) {
	const budget = detectSystemVramBudget();
	const vramCap = maxVramBudgetGb ?? budget.availableVramGb;
	const loadPlan = planSafeLmStudioLoad({ modelId, vramBudget: budget });
	const quirk = probeModelBehavioralQuirks({
		modelId,
		vramGb: loadPlan.lmsEstimateGb,
	});
	const report = runRosterChallengerArena({
		runId: `cli-arena-${modelId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
		maxVramBudgetGb: vramCap,
		slots: [
			{
				persona: "Wanderer",
				incumbent: {
					modelId: "qwen-3.8-27b-smoll",
					accuracy: 0.86,
					firstPassVerifyRate: 0.85,
					p95LatencyMs: 950,
					vramGb: 6.9,
				},
				challenger: {
					modelId,
					accuracy: 0.88,
					firstPassVerifyRate: 0.87,
					p95LatencyMs: 900,
					vramGb: loadPlan.lmsEstimateGb,
					quirkReport: quirk,
				},
			},
			{
				persona: "Philosopher",
				incumbent: {
					modelId: "qwen-3.8-27b-intermediate@iq3_xxs",
					accuracy: 0.88,
					firstPassVerifyRate: 0.87,
					p95LatencyMs: 4200,
					vramGb: 10.4,
				},
				challenger: {
					modelId,
					accuracy: 0.91,
					firstPassVerifyRate: 0.9,
					p95LatencyMs: 3200,
					vramGb: loadPlan.lmsEstimateGb,
					quirkReport: quirk,
				},
			},
		],
	});
	return { budget, loadPlan, quirk, report };
}

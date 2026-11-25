/**
 * System 2 Upstream Sync (`earendil-works/pi` -> `pi-system2`):
 * Commit Classifier, Modular Hook Boundary Auditor, Dual-Mode Resolver, and 300-LOC Wave Planner.
 */

import { execFileSync } from "node:child_process";

export type UpstreamCommitCategory =
	| "security"
	| "provider_update"
	| "durable_session"
	| "core_bugfix"
	| "cosmetic_or_docs";
export type UpstreamCollisionRisk = "none" | "hook_boundary" | "direct_conflict";
export type System2ExecutionMode = "vanilla" | "full" | "sentinel-only";
export type GitCommandRunner = (args: readonly string[], cwd?: string) => string;

export interface UpstreamCommitInput {
	sha: string;
	subject: string;
	body?: string;
	files: readonly string[];
	linesChanged?: number;
	insertions?: number;
	deletions?: number;
}

export interface ClassifiedUpstreamCommit extends UpstreamCommitInput {
	category: UpstreamCommitCategory;
	collisionRisk: UpstreamCollisionRisk;
	collidingFiles: string[];
	linesChanged: number;
	recommended: boolean;
	rationale: string;
}

export interface ClassifyCommitOptions {
	hookBoundaryFiles?: readonly string[];
	directConflictFiles?: readonly string[];
}

export interface FilterUpstreamOptions extends ClassifyCommitOptions {
	includeCategories?: readonly UpstreamCommitCategory[];
	excludeDirectConflicts?: boolean;
}

export interface FileDiffStat {
	path: string;
	insertions?: number;
	deletions?: number;
	linesChanged?: number;
}

export interface HookFootprintOptions {
	maxHookLinesPerFile?: number;
	hookThreshold?: number;
	maxTotalCoreHookLines?: number;
}

export interface HookFootprintViolation {
	path: string;
	linesChanged: number;
	threshold: number;
	reason: string;
}

export interface HookFootprintAuditReport {
	withinBoundary: boolean;
	hookThreshold: number;
	system2FileCount: number;
	system2LinesChanged: number;
	coreFileCount: number;
	coreLinesChanged: number;
	encapsulationRatio: number;
	system2Files: Array<{ path: string; linesChanged: number }>;
	coreFiles: Array<{ path: string; linesChanged: number; exceedsThreshold: boolean }>;
	flaggedCoreFiles: string[];
	violations: HookFootprintViolation[];
}

export interface ResolveModeOptions {
	argv?: readonly string[];
	env?: NodeJS.ProcessEnv;
	defaultMode?: System2ExecutionMode;
}

export interface System2ExecutionProfile {
	mode: System2ExecutionMode;
	source: "cli_flag" | "env_var" | "default";
	isVanilla: boolean;
	modernBertRouterEnabled: boolean;
	regime2ThinkingOffEnabled: boolean;
	lfmTelemetrySentinelEnabled: boolean;
	sub25msRollbackEnabled: boolean;
	strippedArgv: string[];
}

export interface PlanSyncWavesOptions extends ClassifyCommitOptions {
	sizeCap?: number;
	ticketPrefix?: string;
	worktreeBaseDir?: string;
	filterCosmetic?: boolean;
}

export interface UpstreamSyncWave {
	waveIndex: number;
	waveId: string;
	ticket: string;
	slug: string;
	worktreePath: string;
	branchName: string;
	commits: ClassifiedUpstreamCommit[];
	commitShas: string[];
	totalLines: number;
	linesChanged: number;
	sizeCap: number;
	oversizedAtomicCommit: boolean;
	flaggedOversized: boolean;
	exceedsSizeCap: boolean;
	highestCollisionRisk: UpstreamCollisionRisk;
	touchedFiles: string[];
	warnings: string[];
}

export type UpstreamSyncWaveList = UpstreamSyncWave[] & {
	waves: UpstreamSyncWave[];
	sizeCap: number;
	flaggedOversizedCommits: string[];
};

export const DEFAULT_SYSTEM2_HOOK_FILES: readonly string[] = [
	"packages/coding-agent/src/config.ts",
	"packages/coding-agent/src/core/slash-commands.ts",
	"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
	"packages/coding-agent/src/cli/package-manager-cli.ts",
	"packages/coding-agent/src/core/agent-session.ts",
	"packages/coding-agent/src/main.ts",
];

const SECURITY_RE =
	/\b(sec|security|cve-\d+|vuln|vulnerability|xss|injection|rce|auth[-_\s]?bypass|sanitize|hardening|ssrf|csrf|path[-_\s]?traversal)\b/i;
const PROVIDER_RE =
	/\b(provider|providers|model|models|catalog|anthropic|openai|gemini|bedrock|vertex|openrouter|claude|gpt|oauth|thinking|token[-_\s]?limit)\b/i;
const DURABLE_SESSION_RE =
	/\b(session|sessions|durable|checkpoint|resume|persistence|jsonl|compaction|transcript|recovery|history)\b/i;
const BUGFIX_RE = /\b(fix|bug|crash|race|leak|deadlock|regression|hang|exception|fallback|error)\b/i;
const COSMETIC_PREFIX_RE = /^(docs|style|chore|ci|test)(\([^)]*\))?!?\s*:/i;
const DOC_FILE_RE = /(^|\/)(docs\/|\.github\/|README|CHANGELOG|LICENSE)|\.(md|mdx|txt|png|jpg|svg|gif)$/i;
const SYSTEM2_ISOLATED_PATH_RE = /(^|\/)src\/core\/system2\//;
const RISK_RANK: Record<UpstreamCollisionRisk, number> = { none: 0, hook_boundary: 1, direct_conflict: 2 };

const normalizePath = (p: string): string => p.trim().replace(/\\/g, "/").replace(/^\.\//, "");

function matchesTargetFile(candidate: string, patterns: readonly string[]): boolean {
	const norm = normalizePath(candidate);
	const base = norm.split("/").pop() ?? norm;
	return patterns.some((p) => {
		const np = normalizePath(p);
		return norm === np || norm.endsWith(`/${np}`) || base === np;
	});
}

function computeChangedLines(item: { linesChanged?: number; insertions?: number; deletions?: number }): number {
	const raw = item.linesChanged ?? (item.insertions ?? 0) + (item.deletions ?? 0);
	return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/** Default git command runner using `execFileSync` with argument array (zero shell interpolation). */
export const defaultGitRunner: GitCommandRunner = (args, cwd) =>
	execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Classifies an upstream commit from `earendil-works/pi` by value category and System 2 hook collision risk. */
export function classifyUpstreamCommit(
	commit: UpstreamCommitInput,
	options: ClassifyCommitOptions = {},
): ClassifiedUpstreamCommit {
	const hookFiles = options.hookBoundaryFiles ?? DEFAULT_SYSTEM2_HOOK_FILES;
	const directFiles = options.directConflictFiles ?? [];
	const normFiles = commit.files.map(normalizePath).filter(Boolean);
	const text = `${commit.subject}\n${commit.body ?? ""}`;

	const directMatches = normFiles.filter(
		(f) => SYSTEM2_ISOLATED_PATH_RE.test(f) || (directFiles.length > 0 && matchesTargetFile(f, directFiles)),
	);
	const hookMatches = normFiles.filter((f) => !directMatches.includes(f) && matchesTargetFile(f, hookFiles));
	const collisionRisk: UpstreamCollisionRisk =
		directMatches.length > 0 ? "direct_conflict" : hookMatches.length > 0 ? "hook_boundary" : "none";
	const collidingFiles = [...directMatches, ...hookMatches];
	const allDocs = normFiles.length > 0 && normFiles.every((f) => DOC_FILE_RE.test(f));

	let category: UpstreamCommitCategory = "cosmetic_or_docs";
	if (
		SECURITY_RE.test(text) ||
		/^(sec|security)(\([^)]*\))?!?\s*:/i.test(commit.subject) ||
		normFiles.some((f) => /(security|auth|sanitize|permissions)/i.test(f) && !DOC_FILE_RE.test(f))
	) {
		category = "security";
	} else if (allDocs) {
		category = "cosmetic_or_docs";
	} else if (
		PROVIDER_RE.test(text) ||
		normFiles.some((f) => /(^|\/)(packages\/ai\/|providers\/|models\.|catalog\/)/i.test(f))
	) {
		category = "provider_update";
	} else if (
		DURABLE_SESSION_RE.test(text) ||
		normFiles.some((f) => /(^|\/)(session|compaction|transcript|checkpoint)/i.test(f))
	) {
		category = "durable_session";
	} else if (!COSMETIC_PREFIX_RE.test(commit.subject) && (BUGFIX_RE.test(text) || normFiles.length > 0)) {
		category = "core_bugfix";
	}

	const linesChanged = computeChangedLines(commit);
	const recommended = category !== "cosmetic_or_docs";
	const rationale = `${category} (${collisionRisk}${collidingFiles.length ? `: ${collidingFiles.join(", ")}` : ""})`;
	return {
		...commit,
		files: normFiles,
		category,
		collisionRisk,
		collidingFiles,
		linesChanged,
		recommended,
		rationale,
	};
}

/** Filters a list of upstream commits down to meaningful patches worth cherry-picking into `pi-system2`. */
export function filterMeaningfulUpstreamCommits(
	commits: readonly UpstreamCommitInput[],
	options: FilterUpstreamOptions = {},
): ClassifiedUpstreamCommit[] {
	const allowed = new Set<UpstreamCommitCategory>(
		options.includeCategories ?? ["security", "provider_update", "durable_session", "core_bugfix"],
	);
	return commits
		.map((c) => classifyUpstreamCommit(c, options))
		.filter(
			(c) => allowed.has(c.category) && (!options.excludeDirectConflicts || c.collisionRisk !== "direct_conflict"),
		);
}

/** Parses `git diff --numstat` output into structured `FileDiffStat` entries. */
export function parseGitDiffNumstat(rawNumstat: string): FileDiffStat[] {
	const stats: FileDiffStat[] = [];
	for (const line of rawNumstat.split(/\r?\n/)) {
		const parts = line.trim().split(/\t+/);
		if (parts.length < 3) continue;
		const insertions = Number.parseInt(parts[0], 10) || 0;
		const deletions = Number.parseInt(parts[1], 10) || 0;
		stats.push({
			path: normalizePath(parts.slice(2).join("\t")),
			insertions,
			deletions,
			linesChanged: insertions + deletions,
		});
	}
	return stats;
}

/** Audits the diff between `upstream/main` and `HEAD` to keep System 2 encapsulated in `src/core/system2/**`. */
export function auditSystem2HookFootprint(
	diffs: readonly FileDiffStat[],
	options: HookFootprintOptions | number = {},
): HookFootprintAuditReport {
	const opts: HookFootprintOptions = typeof options === "number" ? { maxHookLinesPerFile: options } : options;
	const hookThreshold = opts.maxHookLinesPerFile ?? opts.hookThreshold ?? 25;
	const system2Files: Array<{ path: string; linesChanged: number }> = [];
	const coreFiles: Array<{ path: string; linesChanged: number; exceedsThreshold: boolean }> = [];
	const violations: HookFootprintViolation[] = [];

	for (const entry of diffs) {
		const path = normalizePath(entry.path);
		if (!path) continue;
		const linesChanged = computeChangedLines(entry);
		if (SYSTEM2_ISOLATED_PATH_RE.test(path)) {
			system2Files.push({ path, linesChanged });
		} else {
			const exceedsThreshold = linesChanged > hookThreshold;
			coreFiles.push({ path, linesChanged, exceedsThreshold });
			if (exceedsThreshold) {
				violations.push({
					path,
					linesChanged,
					threshold: hookThreshold,
					reason: `Core pi file ${path} modified by ${linesChanged} lines (exceeds ${hookThreshold}-line hook threshold)`,
				});
			}
		}
	}

	const system2LinesChanged = system2Files.reduce((acc, f) => acc + f.linesChanged, 0);
	const coreLinesChanged = coreFiles.reduce((acc, f) => acc + f.linesChanged, 0);
	if (opts.maxTotalCoreHookLines !== undefined && coreLinesChanged > opts.maxTotalCoreHookLines) {
		violations.push({
			path: "<total-core-footprint>",
			linesChanged: coreLinesChanged,
			threshold: opts.maxTotalCoreHookLines,
			reason: `Total core pi hook lines (${coreLinesChanged}) exceed aggregate cap (${opts.maxTotalCoreHookLines})`,
		});
	}
	const totalLines = system2LinesChanged + coreLinesChanged;
	return {
		withinBoundary: violations.length === 0,
		hookThreshold,
		system2FileCount: system2Files.length,
		system2LinesChanged,
		coreFileCount: coreFiles.length,
		coreLinesChanged,
		encapsulationRatio: totalLines === 0 ? 1 : system2LinesChanged / totalLines,
		system2Files,
		coreFiles,
		flaggedCoreFiles: coreFiles.filter((f) => f.exceedsThreshold).map((f) => f.path),
		violations,
	};
}

function parseModeToken(raw: string | undefined): System2ExecutionMode | undefined {
	if (!raw) return undefined;
	const n = raw.trim().toLowerCase();
	if (n === "vanilla" || n === "bypass" || n === "bypass-sys2" || n === "off" || n === "0" || n === "false")
		return "vanilla";
	if (n === "sentinel-only" || n === "sentinel") return "sentinel-only";
	if (n === "full" || n === "sys2" || n === "on" || n === "1" || n === "true") return "full";
	return undefined;
}

/** Resolves whether the unified `pi-system2` binary runs in `full`, `sentinel-only`, or raw `vanilla` mode. */
export function resolveSystem2ExecutionMode(
	input: ResolveModeOptions | readonly string[] = {},
	envArg?: NodeJS.ProcessEnv,
): System2ExecutionProfile {
	const opts: ResolveModeOptions = Array.isArray(input) ? { argv: input, env: envArg } : (input as ResolveModeOptions);
	const argv = opts.argv ?? [];
	const env = opts.env ?? process.env;
	let cliMode: System2ExecutionMode | undefined;
	const strippedArgv: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--vanilla" || arg === "--bypass-sys2" || arg === "--no-sys2") cliMode = "vanilla";
		else if (arg === "--sentinel-only") cliMode = "sentinel-only";
		else if (arg === "--sys2" || arg === "--full-sys2") cliMode = "full";
		else if (arg.startsWith("--system2-mode=") || arg.startsWith("--mode=")) {
			const parsed = parseModeToken(arg.slice(arg.indexOf("=") + 1));
			if (parsed) cliMode = parsed;
			else strippedArgv.push(arg);
		} else if ((arg === "--system2-mode" || arg === "--mode") && i + 1 < argv.length) {
			const parsed = parseModeToken(argv[i + 1]);
			if (parsed) {
				cliMode = parsed;
				i++;
			} else strippedArgv.push(arg);
		} else strippedArgv.push(arg);
	}

	const envMode = parseModeToken(env.SYSTEM2_MODE ?? env.PI_SYSTEM2_MODE);
	const mode: System2ExecutionMode = cliMode ?? envMode ?? opts.defaultMode ?? "full";
	const source: "cli_flag" | "env_var" | "default" = cliMode ? "cli_flag" : envMode ? "env_var" : "default";
	return {
		mode,
		source,
		isVanilla: mode === "vanilla",
		modernBertRouterEnabled: mode === "full",
		regime2ThinkingOffEnabled: mode === "full",
		lfmTelemetrySentinelEnabled: mode === "full" || mode === "sentinel-only",
		sub25msRollbackEnabled: mode === "full",
		strippedArgv,
	};
}

/** Groups upstream commits into ordered cherry-pick waves respecting the `/software-factory` 300-LOC `size_cap`. */
export function planUpstreamSyncWaves(
	commits: readonly (UpstreamCommitInput | ClassifiedUpstreamCommit)[],
	options: PlanSyncWavesOptions | number = {},
): UpstreamSyncWaveList {
	const opts: PlanSyncWavesOptions = typeof options === "number" ? { sizeCap: options } : options;
	const sizeCap = opts.sizeCap && opts.sizeCap > 0 ? opts.sizeCap : 300;
	const ticketPrefix = opts.ticketPrefix ?? "S2-UPSYNC";
	const worktreeBaseDir = (opts.worktreeBaseDir ?? "pi-system2-worktrees").replace(/\/+$/, "");

	const classified = commits
		.map((c) => ("category" in c && "collisionRisk" in c ? c : classifyUpstreamCommit(c, opts)))
		.filter((c) => !opts.filterCosmetic || c.category !== "cosmetic_or_docs");

	const batches: Array<{ items: ClassifiedUpstreamCommit[]; oversized: boolean }> = [];
	let current: ClassifiedUpstreamCommit[] = [];
	let currentLines = 0;

	for (const commit of classified) {
		const lines = computeChangedLines(commit);
		if (lines > sizeCap) {
			if (current.length > 0) batches.push({ items: current, oversized: false });
			current = [];
			currentLines = 0;
			batches.push({ items: [commit], oversized: true });
			continue;
		}
		if (current.length > 0 && currentLines + lines > sizeCap) {
			batches.push({ items: current, oversized: false });
			current = [];
			currentLines = 0;
		}
		current.push(commit);
		currentLines += lines;
	}
	if (current.length > 0) batches.push({ items: current, oversized: false });

	const flaggedOversizedCommits: string[] = [];
	const waves: UpstreamSyncWave[] = batches.map((batch, idx) => {
		const waveIndex = idx + 1;
		const waveId = `wave-${waveIndex}`;
		const ticket = `${ticketPrefix}-${String(waveIndex).padStart(2, "0")}`;
		const slug = `${ticket}-${waveId}`;
		const totalLines = batch.items.reduce((sum, c) => sum + c.linesChanged, 0);
		const touchedFiles = Array.from(new Set(batch.items.flatMap((c) => c.files)));
		let highestCollisionRisk: UpstreamCollisionRisk = "none";
		for (const c of batch.items) {
			if (RISK_RANK[c.collisionRisk] > RISK_RANK[highestCollisionRisk]) highestCollisionRisk = c.collisionRisk;
		}
		const warnings: string[] = [];
		if (batch.oversized) {
			flaggedOversizedCommits.push(batch.items[0].sha);
			warnings.push(`Atomic commit ${batch.items[0].sha} (${totalLines} LOC) exceeds size_cap (${sizeCap} LOC)`);
		}
		return {
			waveIndex,
			waveId,
			ticket,
			slug,
			worktreePath: `${worktreeBaseDir}/upstream-sync-${waveId}`,
			branchName: `upstream-sync/${waveId}`,
			commits: batch.items,
			commitShas: batch.items.map((c) => c.sha),
			totalLines,
			linesChanged: totalLines,
			sizeCap,
			oversizedAtomicCommit: batch.oversized,
			flaggedOversized: batch.oversized,
			exceedsSizeCap: totalLines > sizeCap,
			highestCollisionRisk,
			touchedFiles,
			warnings,
		};
	});

	const waveList = waves as UpstreamSyncWaveList;
	Object.defineProperty(waveList, "waves", { value: waves, enumerable: false });
	Object.defineProperty(waveList, "sizeCap", { value: sizeCap, enumerable: false });
	Object.defineProperty(waveList, "flaggedOversizedCommits", { value: flaggedOversizedCommits, enumerable: false });
	return waveList;
}

const esc = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");

/** Renders a deterministic `/software-factory` `spec.toml` for executing `verify.py` on an upstream sync wave worktree. */
export function renderUpstreamSyncSpecToml(wave: UpstreamSyncWave): string {
	const shas = wave.commitShas.join(" ");
	const cats = Array.from(new Set(wave.commits.map((c) => c.category))).join(", ") || "core_bugfix";
	const title = `chore(upstream-sync): cherry-pick ${wave.waveId} (${wave.commits.length} commits, ${wave.totalLines} LOC)`;
	const plan = `Cherry-pick upstream commits [${shas}] into ${wave.worktreePath} (${wave.branchName}); collisionRisk=${wave.highestCollisionRisk}.`;
	return [
		`ticket = "${esc(wave.ticket)}"`,
		`slug = "${esc(wave.slug)}"`,
		`title = "${esc(title)}"`,
		`size_cap = ${wave.sizeCap}`,
		"",
		"[split]",
		`step = "${esc(`${wave.waveId} (${wave.worktreePath})`)}"`,
		"",
		"external = []",
		"",
		"[[acceptance]]",
		'name = "hook_boundary_clean"',
		'criterion = "System 2 hook boundary remains encapsulated within src/core/system2/**"',
		'command = "cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/system2-upstream-sync.test.ts"',
		"",
		"[[acceptance]]",
		'name = "tsc_clean"',
		'criterion = "TypeScript build check reports 0 errors in packages/coding-agent"',
		'command = "cd packages/coding-agent && ../../node_modules/.bin/tsc -p tsconfig.build.json --noEmit"',
		"",
		"[expected]",
		`plan = "${esc(plan)}"`,
		`line_count = ${wave.totalLines}`,
		"",
		"[pr]",
		`why = "${esc(`Absorb upstream earendil-works/pi fixes (${cats}) in ${wave.waveId}.`)}"`,
		`merge_effect = "${esc(`Applies ${wave.commits.length} upstream commit(s) onto ${wave.branchName} in ${wave.worktreePath}.`)}"`,
		`rollback = "${esc(`git revert ${shas || "<commit-sha>"}`)}"`,
		'out_of_scope = "Unrelated upstream cosmetic or documentation commits."',
		"",
	].join("\n");
}

/**
 * Native CLI subcommand handler for `system2 factory <status|scan|plan|review>`.
 *
 * Bridges the user's current working directory (`~/test` or any repo) directly
 * to the 3-Tier Software Factory, Neo4j 5.26.0 GraphStore, Phase 0 StackLock,
 * and Antigravity (`agy`) Tier-3 CLI bridge without leaving the `system2` binary.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AGY_OAUTH_TOKEN_FILENAMES, resolveAgyCommand, resolveRealAgyTokenPath, runAgyPrompt } from "./agy-bridge.ts";
import {
	buildTier3LayerReviewPrompt,
	detectUnderspecifiedStack,
	type FactoryKanbanCard,
	probeFactoryHardwareAndModels,
	scheduleKanbanWaves,
} from "./factory.ts";
import { type KanbanCardNode, System2GraphStore } from "./graph-store.ts";

export interface FactoryCliContext {
	cwd: string;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	/** Test seam for interactive REPL lines in `system2 factory chat`. */
	promptLine?: (promptText: string) => Promise<string | undefined>;
}

const DEFAULT_SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"__pycache__",
	".pytest_cache",
	".venv",
	"venv",
]);

function isTestFilePath(filePath: string): boolean {
	return /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)__tests__\//.test(filePath);
}

/** Collects source files from explicit file/directory arguments or the current working directory (up to 2 levels deep). */
export function collectFactoryTargetFiles(cwd: string, targets: readonly string[]): string[] {
	const results: string[] = [];
	const seen = new Set<string>();

	const addFile = (fullPath: string): void => {
		const rel = relative(cwd, fullPath) || fullPath;
		const normalized = rel.startsWith("..") ? fullPath : rel;
		if (seen.has(normalized)) return;
		seen.add(normalized);
		results.push(normalized);
	};

	const walkDir = (dirPath: string, depth: number): void => {
		if (depth > 3) return;
		let entries: string[];
		try {
			entries = readdirSync(dirPath);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name.startsWith(".") || IGNORED_DIRS.has(name)) continue;
			const full = join(dirPath, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walkDir(full, depth + 1);
			} else if (st.isFile()) {
				const dotIdx = name.lastIndexOf(".");
				const ext = dotIdx !== -1 ? name.slice(dotIdx) : "";
				if (DEFAULT_SCAN_EXTENSIONS.has(ext)) addFile(full);
			}
		}
	};

	if (targets.length === 0) {
		walkDir(cwd, 0);
		return results.sort();
	}

	for (const target of targets) {
		const full = resolve(cwd, target);
		if (!existsSync(full)) continue;
		try {
			const st = statSync(full);
			if (st.isDirectory()) {
				walkDir(full, 0);
			} else if (st.isFile()) {
				addFile(full);
			}
		} catch {
			// Skip unreadable targets.
		}
	}
	return results.sort();
}

function detectAvailableLocalModels(): string[] {
	const found = new Set<string>();
	try {
		const out = execFileSync("lms", ["ls"], { encoding: "utf8", timeout: 3000 });
		if (/qwen3\.8-27b-splash/i.test(out)) found.add("lmstudio/qwen3.8-27b-splash");
		if (/qwen3\.5-9b/i.test(out)) found.add("lmstudio/qwen3.5-9b");
		if (/gemma-4-12b/i.test(out)) found.add("lmstudio/google/gemma-4-12b");
	} catch {
		// Fall back to known defaults when `lms` CLI is not on PATH.
	}
	if (found.size === 0) {
		found.add("lmstudio/qwen3.8-27b-splash");
		found.add("lmstudio/qwen3.5-9b");
	}
	return [...found];
}

function formatFactoryHelp(): string {
	return [
		"Usage: system2 factory [subcommand] [options]",
		"",
		"Subcommands:",
		"  chat [goal] [--model <id>]          Interactive Tier-3 Architect session: align on stack, review Neo4j contracts, and lock Kanban plan",
		"  status [--json]                     Probe hardware, Neo4j 5.26.0 graph store, AGY Tier-3 bridge, and local models",
		"  scan [files...] [--json]            Scan source/test contracts in cwd and upsert into Neo4j + JSON fallback",
		"  plan <goal> [--files a,b] [--agy]   Run Phase 0 StackLock check, Neo4j contract scan, and wave schedule (optional live AGY Tier-3 plan)",
		"  review [--card <id>] [--agy]        Build (and optionally execute via AGY Tier-3) a Layer-Up 1-hop contract review for uncommitted git diff",
		"",
		"Interactive chat commands inside `system2 factory chat`:",
		"  /lock [pkg1,pkg2]                   Lock ApprovedStackLock + Kanban waves to .system2/factory-plan.json",
		"  /status                             Show active Tier-3 model, Neo4j status, and conversation id",
		"  /quit                               Exit interactive Tier-3 Architect session",
		"",
		"Examples (from ~/test or any workspace):",
		"  system2 factory chat",
		'  system2 factory chat "Add pause_topic and resume_topic to EventBus in event_bus.py"',
		"  system2 factory status",
		"  system2 factory scan",
		"  system2 factory review --agy",
	].join("\n");
}

function parseFlagValue(args: readonly string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
	return undefined;
}

async function queryLocalLmStudioTurn(params: {
	modelId: string;
	systemPrompt: string;
	history: readonly { role: "user" | "assistant"; content: string }[];
	baseUrl?: string;
}): Promise<{ ok: boolean; text: string; errorDetail?: string }> {
	const cleanModel = params.modelId.replace(/^lmstudio\//, "");
	const endpoint = `${(params.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234").replace(/\/$/, "")}/v1/chat/completions`;
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: cleanModel,
				messages: [{ role: "system", content: params.systemPrompt }, ...params.history],
				temperature: 0.2,
			}),
		});
		if (!res.ok) {
			return { ok: false, text: "", errorDetail: `LM Studio HTTP ${res.status}` };
		}
		const payload = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const content = payload.choices?.[0]?.message?.content ?? "";
		return { ok: true, text: content.trim() };
	} catch (error) {
		return {
			ok: false,
			text: "",
			errorDetail: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Top-level dispatcher for `system2 factory ...`.
 * Returns an exit code (0 on success, 1 on usage/runtime error).
 */
export async function runFactoryCliCommand(args: readonly string[], ctx: FactoryCliContext): Promise<number> {
	const out = ctx.stdout ?? ((line: string) => console.log(line));
	const err = ctx.stderr ?? ((line: string) => console.error(line));
	const rawSub = args[0];
	const jsonMode = args.includes("--json");

	if (rawSub === "--help" || rawSub === "-h" || rawSub === "help") {
		out(formatFactoryHelp());
		return 0;
	}

	// Default `system2 factory` (no subcommand) into interactive Tier-3 Architect chat when a prompt reader or TTY exists.
	const sub = !rawSub ? (ctx.promptLine || process.stdin.isTTY ? "chat" : "help") : rawSub;
	if (sub === "help") {
		out(formatFactoryHelp());
		return 0;
	}

	const store = new System2GraphStore({
		fallbackJsonPath: join(ctx.cwd, ".system2", "factory-graph.json"),
	});

	if (sub === "chat") {
		const filesArg = parseFlagValue(args, "--files");
		const targetFiles = filesArg
			? filesArg
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: collectFactoryTargetFiles(ctx.cwd, []);
		const filePayloads: { path: string; content: string; isTest?: boolean }[] = [];
		for (const relPath of targetFiles) {
			const full = resolve(ctx.cwd, relPath);
			try {
				filePayloads.push({ path: relPath, content: readFileSync(full, "utf8"), isTest: isTestFilePath(relPath) });
			} catch {
				// Ignore unreadable files.
			}
		}
		const upsertRes = await store.upsertCodeContracts(filePayloads);
		const agyBinary = resolveAgyCommand();
		const agyToken = resolveRealAgyTokenPath();
		const hasAgyCli = (agyBinary !== "agy" || existsSync("/opt/homebrew/bin/agy")) && agyToken !== undefined;
		const localModels = detectAvailableLocalModels();
		const totalMemoryGb = Math.round(totalmem() / 1024 ** 3);
		const hardware = probeFactoryHardwareAndModels({
			totalMemoryGb,
			availableLocalModels: localModels,
			hasAgyCli,
			preferLocalTier3: args.includes("--local-tier3"),
		});
		const tier3Model = parseFlagValue(args, "--model") ?? hardware.tier3ArchitectModel;
		const useAgy = tier3Model.startsWith("agy/") || tier3Model.startsWith("antigravity/");

		// Collect optional initial goal passed after `system2 factory chat "<goal>"`
		const positional: string[] = [];
		for (let i = rawSub === "chat" ? 1 : 0; i < args.length; i++) {
			const a = args[i];
			if (a === "--files" || a === "--model") {
				i++;
				continue;
			}
			if (a.startsWith("--")) continue;
			positional.push(a);
		}
		let pendingGoal = positional.join(" ").trim();

		out("=== System 2 Software Factory: Interactive Tier-3 Architect Session ===");
		out(`Workspace:        ${ctx.cwd}`);
		out(
			`Graph Contracts:  ${filePayloads.length} file(s), ${upsertRes.symbolsUpserted} symbols, ${upsertRes.edgesUpserted} edges [${upsertRes.backend}]`,
		);
		out(`Tier-3 Architect: ${tier3Model} (${useAgy ? "isolated 0o700 AGY bridge" : "local LM Studio"})`);
		out(`Tier-2 Worker:    ${hardware.tier2WorkerModel} (${hardware.memoryStrategy})`);
		out("Commands:         /lock [pkg1,pkg2] to lock StackLock & Kanban plan | /status | /quit");
		out("-----------------------------------------------------------------------");

		const rl =
			ctx.promptLine === undefined ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
		const readNextLine = async (promptText: string): Promise<string | undefined> => {
			if (ctx.promptLine) return ctx.promptLine(promptText);
			if (!rl) return undefined;
			return new Promise((resolveLine) => {
				rl.question(promptText, (answer) => resolveLine(answer));
			});
		};

		let conversationId: string | undefined;
		const history: { role: "user" | "assistant"; content: string }[] = [];
		let lastGoal = pendingGoal || "Software Factory feature build";

		const systemContext = [
			"You are the System 2 Tier-3 Software Factory Architect.",
			`Workspace: ${ctx.cwd}`,
			`Scanned files (${upsertRes.symbolsUpserted} symbols, ${upsertRes.edgesUpserted} edges in ${upsertRes.backend}): ${targetFiles.slice(0, 20).join(", ")}`,
			"Your job is to talk through the plan interactively with the developer BEFORE any Tier-2 worker writes code:",
			"1. If any stack choice (agent framework, RAG/vector/graph DB, API framework, auth) is underspecified, present 4-5 vetted options with official docs URLs and ask the developer to choose.",
			"2. Propose a Locked Stack (ApprovedStackLock) so no unapproved SDKs or rogue dependencies can be installed.",
			"3. Propose small, file-scoped Kanban cards (with allowedFiles, maxChangedLines, and deterministic verifyCmd) organized into conflict-free waves.",
			"Keep responses concise, direct, and grounded in the scanned workspace files.",
		].join("\n");

		try {
			while (true) {
				let line: string | undefined;
				if (pendingGoal) {
					line = pendingGoal;
					pendingGoal = "";
					out(`\nYou> ${line}`);
				} else {
					line = await readNextLine("\nYou> ");
				}
				if (line === undefined) break;
				const trimmed = line.trim();
				if (trimmed === "") continue;
				if (trimmed === "/quit" || trimmed === "/exit") {
					out("Exiting Tier-3 Architect session.");
					break;
				}
				if (trimmed === "/status") {
					out(
						`Tier-3: ${tier3Model} | Tier-2: ${hardware.tier2WorkerModel} | Graph: ${upsertRes.backend} (${upsertRes.symbolsUpserted} symbols) | Conversation: ${conversationId ?? "local"}`,
					);
					continue;
				}
				if (trimmed === "/lock" || trimmed.startsWith("/lock ")) {
					const pkgArg = trimmed.slice("/lock".length).trim();
					const allowedPackages = pkgArg
						? pkgArg
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
						: [];
					const sourceFiles = filePayloads.filter((f) => !f.isTest).map((f) => f.path);
					const testFiles = filePayloads.filter((f) => f.isTest).map((f) => f.path);
					const primaryFiles = sourceFiles.length > 0 ? sourceFiles : targetFiles;
					const runId = `locked-${Date.now()}`;
					const graphCards: KanbanCardNode[] = primaryFiles.slice(0, 4).map((file, idx) => {
						const allowedFiles = [file, ...testFiles.slice(0, 1)];
						return {
							id: `S2-CARD-0${idx + 1}`,
							runId,
							title: `${lastGoal} (${file})`,
							status: "todo",
							allowedFiles,
							maxChangedLines: 150,
							verifyCmd: allowedFiles.some((f) => f.endsWith(".py")) ? "pytest -q" : "npx vitest run",
							dependsOn: [],
						};
					});
					await store.upsertKanbanCards(runId, graphCards);
					const coupled = await store.findCoupledCards(runId);
					const factoryCards: FactoryKanbanCard[] = graphCards.map((c) => ({
						id: c.id,
						title: c.title,
						allowedFiles: c.allowedFiles,
						maxChangedLines: c.maxChangedLines,
						verifyCmd: c.verifyCmd,
						dependsOn: c.dependsOn,
					}));
					const waves =
						factoryCards.length > 0
							? scheduleKanbanWaves(factoryCards, coupled).map((w) => w.map((c) => c.id))
							: [];
					const planDir = join(ctx.cwd, ".system2");
					mkdirSync(planDir, { recursive: true });
					const planFile = join(planDir, "factory-plan.json");
					const lockedPlan = {
						lockedAt: new Date().toISOString(),
						goal: lastGoal,
						tier3ArchitectModel: tier3Model,
						tier2WorkerModel: hardware.tier2WorkerModel,
						stackLock: {
							runtime: primaryFiles.some((f) => f.endsWith(".py")) ? "python" : "node",
							allowedPackages,
							referenceDocs: [],
							allowNewDependencies: false,
						},
						cards: factoryCards,
						coupledPairs: coupled,
						waves,
						architectTranscript: history,
					};
					writeFileSync(planFile, JSON.stringify(lockedPlan, null, 2), "utf8");
					out(
						`Locked StackLock + ${factoryCards.length} Kanban card(s) across ${waves.length} wave(s) -> ${planFile}`,
					);
					continue;
				}

				lastGoal = trimmed;
				const stackCheck = detectUnderspecifiedStack(
					trimmed,
					filePayloads.map((f) => f.path),
				);
				let stackHint = "";
				if (stackCheck.needsClarification) {
					const lines: string[] = [
						`[Phase 0 Stack Discovery triggered for categories: ${stackCheck.missingCategories.join(", ")}]`,
					];
					for (const cat of stackCheck.missingCategories) {
						const opts = stackCheck.optionsByCategory[cat] ?? [];
						lines.push(`Category '${cat}' vetted options:`);
						for (const opt of opts) lines.push(`- ${opt.name} (${opt.docsUrl}): ${opt.summary}`);
					}
					stackHint = lines.join("\n");
					out(`\n${stackHint}`);
				}

				history.push({ role: "user", content: trimmed });
				if (useAgy) {
					const promptToSend =
						conversationId === undefined
							? `${systemContext}\n\n${stackHint ? `${stackHint}\n\n` : ""}Developer: ${trimmed}`
							: `${stackHint ? `${stackHint}\n\n` : ""}${trimmed}`;
					const res = await runAgyPrompt({
						prompt: promptToSend,
						model: tier3Model,
						conversationId,
						cwd: ctx.cwd,
					});
					if (res.conversationId) conversationId = res.conversationId;
					const reply = res.ok
						? res.text
						: `[Tier-3 AGY ${res.errorKind ?? "error"}]: ${res.errorDetail ?? "failed"}`;
					history.push({ role: "assistant", content: reply });
					out(`\nTier-3 (${tier3Model})>\n${reply}`);
				} else {
					const res = await queryLocalLmStudioTurn({
						modelId: tier3Model,
						systemPrompt: `${systemContext}${stackHint ? `\n\n${stackHint}` : ""}`,
						history,
					});
					const reply = res.ok ? res.text : `[Tier-3 Local LM Studio error]: ${res.errorDetail ?? "failed"}`;
					history.push({ role: "assistant", content: reply });
					out(`\nTier-3 (${tier3Model})>\n${reply}`);
				}
			}
		} finally {
			rl?.close();
		}
		return 0;
	}

	if (sub === "status") {
		const neo4jOnline = await store.pingNeo4j();
		const agyBinary = resolveAgyCommand();
		const agyToken = resolveRealAgyTokenPath();
		const hasAgyCli = agyBinary !== "agy" || existsSync("/opt/homebrew/bin/agy");
		const localModels = detectAvailableLocalModels();
		const totalMemoryGb = Math.round(totalmem() / 1024 ** 3);
		const hardware = probeFactoryHardwareAndModels({
			totalMemoryGb,
			availableLocalModels: localModels,
			hasAgyCli: hasAgyCli && agyToken !== undefined,
			preferLocalTier3: args.includes("--local-tier3"),
		});
		const payload = {
			cwd: ctx.cwd,
			neo4j: {
				online: neo4jOnline,
				endpoint: "http://127.0.0.1:7474/db/neo4j/tx/commit",
				fallbackJsonPath: join(ctx.cwd, ".system2", "factory-graph.json"),
			},
			agyBridge: {
				binary: agyBinary,
				authenticated: agyToken !== undefined,
				tokenFilename: agyToken?.filename ?? null,
				supportedTokenFilenames: AGY_OAUTH_TOKEN_FILENAMES,
				isolatedHomeMode: "0o700 (Keychains skipped when token file exists)",
			},
			hardware,
		};
		if (jsonMode) {
			out(JSON.stringify(payload, null, 2));
		} else {
			out("=== System 2 Software Factory Status ===");
			out(`Workspace:          ${payload.cwd}`);
			out(
				`Neo4j GraphStore:   ${neo4jOnline ? "ONLINE (http://127.0.0.1:7474)" : "OFFLINE (using .system2/factory-graph.json)"}`,
			);
			out(
				`AGY Tier-3 Bridge:  ${payload.agyBridge.authenticated ? `READY (${payload.agyBridge.binary}, token: ${payload.agyBridge.tokenFilename})` : "NOT AUTHENTICATED"}`,
			);
			out(`System Memory:      ${hardware.totalMemoryGb} GB (${hardware.memoryStrategy})`);
			out(`Tier-3 Architect:   ${hardware.tier3ArchitectModel}`);
			out(`Tier-2 Worker:      ${hardware.tier2WorkerModel}`);
		}
		return 0;
	}

	if (sub === "scan") {
		const positional = args.slice(1).filter((a) => !a.startsWith("--"));
		const files = collectFactoryTargetFiles(ctx.cwd, positional);
		const filePayloads: { path: string; content: string; isTest?: boolean }[] = [];
		for (const relPath of files) {
			const full = resolve(ctx.cwd, relPath);
			try {
				filePayloads.push({
					path: relPath,
					content: readFileSync(full, "utf8"),
					isTest: isTestFilePath(relPath),
				});
			} catch {
				// Skip unreadable file.
			}
		}
		const res = await store.upsertCodeContracts(filePayloads);
		const summary = {
			cwd: ctx.cwd,
			filesScanned: filePayloads.length,
			files: filePayloads.map((f) => f.path),
			...res,
		};
		if (jsonMode) {
			out(JSON.stringify(summary, null, 2));
		} else {
			out(
				`Scanned ${summary.filesScanned} file(s) -> upserted ${res.symbolsUpserted} symbols and ${res.edgesUpserted} edges [backend: ${res.backend}]`,
			);
			for (const f of summary.files) out(`  - ${f}`);
		}
		return 0;
	}

	if (sub === "plan") {
		const positional: string[] = [];
		for (let i = 1; i < args.length; i++) {
			const a = args[i];
			if (a === "--files" || a === "--model") {
				i++;
				continue;
			}
			if (a.startsWith("--")) continue;
			positional.push(a);
		}
		const goal = positional.join(" ").trim();
		if (!goal) {
			err(
				'Error: `system2 factory plan` requires a goal prompt (e.g. `system2 factory plan "Add DLQ to EventBus"`).',
			);
			return 1;
		}

		// 1. Phase 0 StackLock discovery check
		const filesArg = parseFlagValue(args, "--files");
		const targetFiles = filesArg
			? filesArg
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: collectFactoryTargetFiles(ctx.cwd, []);

		const filePayloads: { path: string; content: string; isTest?: boolean }[] = [];
		for (const relPath of targetFiles) {
			const full = resolve(ctx.cwd, relPath);
			try {
				filePayloads.push({ path: relPath, content: readFileSync(full, "utf8"), isTest: isTestFilePath(relPath) });
			} catch {
				// Skip unreadable file.
			}
		}

		const stackCheck = detectUnderspecifiedStack(
			goal,
			filePayloads.map((f) => f.path),
		);
		const upsertRes = await store.upsertCodeContracts(filePayloads);

		const sourceFiles = filePayloads.filter((f) => !f.isTest).map((f) => f.path);
		const testFiles = filePayloads.filter((f) => f.isTest).map((f) => f.path);
		const primaryFiles = sourceFiles.length > 0 ? sourceFiles : targetFiles;

		const runId = `plan-${Date.now()}`;
		const graphCards: KanbanCardNode[] = primaryFiles.slice(0, 4).map((file, idx) => {
			const allowedFiles = [file, ...testFiles.slice(0, 1)];
			return {
				id: `S2-CARD-0${idx + 1}`,
				runId,
				title: `${goal} (${file})`,
				status: "todo",
				allowedFiles,
				maxChangedLines: 150,
				verifyCmd: allowedFiles.some((f) => f.endsWith(".py")) ? "pytest -q" : "npx vitest run",
				dependsOn: [],
			};
		});
		await store.upsertKanbanCards(runId, graphCards);
		const coupled = await store.findCoupledCards(runId);
		const factoryCards: FactoryKanbanCard[] = graphCards.map((c) => ({
			id: c.id,
			title: c.title,
			allowedFiles: c.allowedFiles,
			maxChangedLines: c.maxChangedLines,
			verifyCmd: c.verifyCmd,
			dependsOn: c.dependsOn,
		}));
		const waves =
			factoryCards.length > 0 ? scheduleKanbanWaves(factoryCards, coupled).map((w) => w.map((c) => c.id)) : [];

		let agyPlanText: string | undefined;
		if (args.includes("--agy")) {
			const adj = graphCards[0] ? await store.getAdjacentLayerContext(graphCards[0].id) : undefined;
			const agyModel = parseFlagValue(args, "--model") ?? "agy/gemini-3.8-flash-high";
			const agyRes = await runAgyPrompt({
				prompt: [
					`You are the System 2 Tier-3 Software Factory Architect.`,
					`Workspace: ${ctx.cwd}`,
					`Goal: ${goal}`,
					`Files scanned (${upsertRes.symbolsUpserted} symbols, ${upsertRes.edgesUpserted} edges in ${upsertRes.backend}): ${targetFiles.join(", ")}`,
					adj ? `1-hop contract triples (sample):\n${adj.neighborTriples.slice(0, 20).join("\n")}` : "",
					`Decompose this goal into 2-3 small, file-scoped Kanban cards with deterministic verify commands.`,
				]
					.filter(Boolean)
					.join("\n\n"),
				model: agyModel,
				cwd: ctx.cwd,
			});
			agyPlanText = agyRes.ok ? agyRes.text : `[AGY error: ${agyRes.errorKind}] ${agyRes.errorDetail ?? ""}`;
		}

		const planPayload = {
			goal,
			stackDiscovery: stackCheck,
			graphSync: upsertRes,
			cards: factoryCards,
			coupledPairs: coupled,
			waves,
			...(agyPlanText !== undefined ? { agyTier3Plan: agyPlanText } : {}),
		};

		if (jsonMode) {
			out(JSON.stringify(planPayload, null, 2));
		} else {
			out("=== System 2 Software Factory Plan ===");
			out(`Goal:          ${goal}`);
			out(
				`Graph Sync:    ${upsertRes.symbolsUpserted} symbols, ${upsertRes.edgesUpserted} edges [${upsertRes.backend}]`,
			);
			if (stackCheck.needsClarification) {
				out(`Phase 0 Stack: CLARIFICATION RECOMMENDED for [${stackCheck.missingCategories.join(", ")}]`);
				for (const cat of stackCheck.missingCategories) {
					const opts = stackCheck.optionsByCategory[cat] ?? [];
					out(`  Category '${cat}' options:`);
					for (const opt of opts) out(`    * ${opt.name} (${opt.docsUrl}) — ${opt.summary}`);
				}
			} else {
				out("Phase 0 Stack: LOCKED (no underspecified stack categories detected)");
			}
			out(`Scheduled Waves (${waves.length}): ${JSON.stringify(waves)}`);
			if (agyPlanText !== undefined) {
				out("\n=== AGY Tier-3 Architect Decomposition ===");
				out(agyPlanText);
			}
		}
		return 0;
	}

	if (sub === "review") {
		const cardId = parseFlagValue(args, "--card") ?? "S2-REVIEW-01";
		const filesArg = parseFlagValue(args, "--files");
		const files = filesArg
			? filesArg
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: collectFactoryTargetFiles(ctx.cwd, []);
		const filePayloads: { path: string; content: string; isTest?: boolean }[] = [];
		for (const relPath of files) {
			const full = resolve(ctx.cwd, relPath);
			try {
				filePayloads.push({ path: relPath, content: readFileSync(full, "utf8"), isTest: isTestFilePath(relPath) });
			} catch {
				// Ignore unreadable files.
			}
		}
		await store.upsertCodeContracts(filePayloads);
		const sourceFiles = filePayloads.filter((f) => !f.isTest).map((f) => f.path);
		await store.upsertKanbanCards("review-run", [
			{
				id: cardId,
				runId: "review-run",
				title: `Layer-Up Contract Review (${cardId})`,
				status: "in_progress",
				allowedFiles: sourceFiles,
				maxChangedLines: 200,
				verifyCmd: sourceFiles.some((f) => f.endsWith(".py")) ? "pytest -q" : "npx vitest run",
				dependsOn: [],
			},
		]);
		const adj = await store.getAdjacentLayerContext(cardId);
		let gitDiff = "";
		try {
			gitDiff = execFileSync("git", ["diff", "HEAD"], {
				cwd: ctx.cwd,
				encoding: "utf8",
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			// Not a git repo or no HEAD; leave diff empty.
		}
		const prompt = buildTier3LayerReviewPrompt({
			card: {
				id: cardId,
				title: `Layer-Up Contract Review in ${ctx.cwd}`,
				allowedFiles: sourceFiles,
				maxChangedLines: 200,
				verifyCmd: sourceFiles.some((f) => f.endsWith(".py")) ? "pytest -q" : "npx vitest run",
				dependsOn: [],
			},
			gitDiff: gitDiff || "(no uncommitted git diff; reviewing current file contracts)",
			neighborTriples: adj.neighborTriples,
			neighborTests: adj.neighborTests,
			arbiterRejections: adj.priorRejections,
		});

		if (args.includes("--agy")) {
			const agyModel = parseFlagValue(args, "--model") ?? "agy/gemini-3.8-flash-high";
			const agyRes = await runAgyPrompt({
				prompt: `${prompt}\n\nRespond with a concise Layer-Up contract verdict (PASS or CONFLICTS) in 3 bullet points.`,
				model: agyModel,
				cwd: ctx.cwd,
			});
			if (jsonMode) {
				out(
					JSON.stringify(
						{ cardId, neighborTests: adj.neighborTests, triples: adj.neighborTriples.length, agyRes },
						null,
						2,
					),
				);
			} else {
				out(`=== Tier-3 Layer-Up Review via AGY (${agyRes.model}${agyRes.effort ? `-${agyRes.effort}` : ""}) ===`);
				out(
					`1-Hop Contract Triples: ${adj.neighborTriples.length} | Neighbor Tests: ${adj.neighborTests.join(", ") || "none"}`,
				);
				out(agyRes.ok ? agyRes.text : `AGY Error (${agyRes.errorKind}): ${agyRes.errorDetail}`);
			}
			return agyRes.ok ? 0 : 1;
		}

		if (jsonMode) {
			out(
				JSON.stringify(
					{
						cardId,
						touchedFiles: adj.touchedFiles,
						neighborTests: adj.neighborTests,
						triplesCount: adj.neighborTriples.length,
						reviewPrompt: prompt,
					},
					null,
					2,
				),
			);
		} else {
			out(prompt);
		}
		return 0;
	}

	err(`Unknown 'system2 factory' subcommand: "${sub}". Run 'system2 factory --help' for usage.`);
	return 1;
}

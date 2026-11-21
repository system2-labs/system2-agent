// System 2 Software Factory orchestrator: Phase 0 ApprovedStackLock no-rogue-SDK gate,
// hardware/model probe, lean pi worker CLI builder, disjoint kanban wave scheduler,
// worker watchdog, and Tier-3 Layer-Up Integrator prompt builder.
import { homedir } from "node:os";

export interface StackOption {
	name: string;
	summary: string;
	docsUrl: string;
}

export interface ApprovedStackLock {
	allowedPackages: readonly string[];
	allowNewDependencies: boolean;
	docReferences?: readonly string[];
}

export interface StackLockVerdict {
	allowed: boolean;
	violationPackage?: string;
	reason?: string;
}

const AGENT_FRAMEWORK_OPTIONS: readonly StackOption[] = [
	{
		name: "System2 Native Harness",
		summary: "Pi-native tiered orchestration with System 2 verification gates",
		docsUrl: "https://github.com/badlogic/pi-mono",
	},
	{
		name: "Hermes Kanban Gateway",
		summary: "Kanban-scheduled multi-agent gateway with disjoint task waves",
		docsUrl: "https://docs.system2.dev/hermes-kanban",
	},
	{
		name: "PydanticAI",
		summary: "Typed Python agent framework with dependency graph and structured outputs",
		docsUrl: "https://docs.pydantic.dev/pydantic-ai/",
	},
	{
		name: "LangGraph",
		summary: "Stateful graph-based agent orchestration with checkpointing",
		docsUrl: "https://langchain-ai.github.io/langgraph/",
	},
	{
		name: "OpenAI Agents SDK",
		summary: "Handoff-based agent composition on OpenAI models",
		docsUrl: "https://openai.github.io/openai-agents-python/",
	},
];

const RAG_OR_GRAPH_OPTIONS: readonly StackOption[] = [
	{
		name: "Neo4j + AtlasKV Triples",
		summary: "Cypher property graph plus KV triple store for entity retrieval",
		docsUrl: "https://neo4j.com/docs/cypher-manual/current/",
	},
	{
		name: "PostgreSQL + pgvector",
		summary: "Transactional store with vector indexes in one database",
		docsUrl: "https://github.com/pgvector/pgvector",
	},
	{
		name: "SQLite-vec / DuckDB",
		summary: "Embeddable zero-server local vector search",
		docsUrl: "https://github.com/asg017/sqlite-vec",
	},
	{
		name: "LanceDB",
		summary: "Columnar vector database with native embedding integration",
		docsUrl: "https://lancedb.github.io/lancedb/",
	},
	{
		name: "Qdrant",
		summary: "Dedicated vector search server with payload filtering",
		docsUrl: "https://qdrant.tech/documentation/",
	},
];

const AGENT_FRAMEWORK_RE = /\bagent(?:\s+system|\s+framework|\s+orchestrat)/i;
const AGENT_FRAMEWORK_SPECIFIED_RE = /\b(system2|pi|hermes|langgraph|autogen|crewai|pydantic-ai)\b/i;
const RAG_TRIGGER_RE = /\b(rag|knowledge\s+graph|vector\s+search|retrieval)\b/i;
const RAG_SPECIFIED_RE = /\b(neo4j|atlaskv|pgvector|qdrant|lance|sqlite-vec)\b/i;

/** Detects broad architectural asks in a goal prompt that name no concrete stack and returns vetted options for clarification. */
export function detectUnderspecifiedStack(
	goalPrompt: string,
	existingPackages: readonly string[] = [],
): {
	needsClarification: boolean;
	missingCategories: string[];
	optionsByCategory: Record<string, readonly StackOption[]>;
} {
	const haystack = [goalPrompt, ...existingPackages].join(" ");
	const missingCategories: string[] = [];
	const optionsByCategory: Record<string, readonly StackOption[]> = {};
	if (AGENT_FRAMEWORK_RE.test(goalPrompt) && !AGENT_FRAMEWORK_SPECIFIED_RE.test(haystack)) {
		missingCategories.push("agent_framework");
		optionsByCategory.agent_framework = AGENT_FRAMEWORK_OPTIONS;
	}
	if (RAG_TRIGGER_RE.test(goalPrompt) && !RAG_SPECIFIED_RE.test(haystack)) {
		missingCategories.push("rag_or_graph");
		optionsByCategory.rag_or_graph = RAG_OR_GRAPH_OPTIONS;
	}
	return { needsClarification: missingCategories.length > 0, missingCategories, optionsByCategory };
}

const INSTALL_COMMAND_RE = /\b(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add|pip\s+install|uv\s+add|cargo\s+add)\s*(.*)$/;

function packageNameOf(token: string): string {
	if (token.startsWith("@")) {
		const at = token.indexOf("@", 1);
		return at === -1 ? token : token.slice(0, at);
	}
	const match = token.match(/^[^@>=<~,^]+/);
	return match ? match[0] : token;
}

/** Blocks package-install commands that add dependencies outside the ApprovedStackLock. */
export function verifyCommandAgainstStackLock(command: string, stackLock: ApprovedStackLock): StackLockVerdict {
	const match = INSTALL_COMMAND_RE.exec(command);
	if (!match || stackLock.allowNewDependencies) return { allowed: true };
	// Flag tokens (-D, --save-dev, -r, ...) are skipped, so bare `npm install` installs nothing and passes.
	for (const token of match[1].split(/\s+/)) {
		if (!token || token.startsWith("-")) continue;
		const pkg = packageNameOf(token);
		if (!pkg) continue;
		if (!stackLock.allowedPackages.includes(pkg)) {
			return { allowed: false, violationPackage: pkg, reason: `Package ${pkg} is not in ApprovedStackLock` };
		}
	}
	return { allowed: true };
}

const IMPORT_RE = /(?:from\s*|require\(\s*)(["'])([^."'][^"']*)\1/g;
const NODE_BUILTINS = new Set([
	"fs",
	"path",
	"os",
	"child_process",
	"crypto",
	"url",
	"util",
	"http",
	"https",
	"stream",
	"events",
	"assert",
]);

function importPackageRoot(spec: string): string {
	if (spec.startsWith("@")) {
		const parts = spec.split("/");
		return parts.slice(0, 2).join("/");
	}
	return spec.split("/")[0];
}

/** Blocks source imports of packages outside the ApprovedStackLock; node built-ins always pass. */
export function verifySourceImportsAgainstStackLock(
	sourceCode: string,
	stackLock: ApprovedStackLock,
): StackLockVerdict {
	if (stackLock.allowNewDependencies) return { allowed: true };
	for (const match of sourceCode.matchAll(IMPORT_RE)) {
		const spec = match[2];
		if (spec.startsWith("node:") || spec.startsWith(".") || NODE_BUILTINS.has(spec.split("/")[0])) continue;
		const root = importPackageRoot(spec);
		if (!stackLock.allowedPackages.includes(root)) {
			return {
				allowed: false,
				violationPackage: root,
				reason: `Unapproved SDK import of ${root} violates ApprovedStackLock`,
			};
		}
	}
	return { allowed: true };
}

export interface HardwareModelRecommendation {
	totalMemoryGb: number;
	memoryStrategy: "co-resident" | "wave-swap";
	tier3ArchitectModel: string;
	tier2WorkerModel: string;
	hfRecommendations: readonly { tier: string; modelId: string; vramGb: number; note: string }[];
}

const HF_SMALL_MEMORY = [
	{ tier: "8-16GB", modelId: "Qwen/Qwen3.5-9B-GGUF", vramGb: 6, note: "Quantized 9B fits comfortably on a laptop" },
	{ tier: "8-16GB", modelId: "google/gemma-4-12b-MLX-4bit", vramGb: 8, note: "MLX 4-bit 12B for Apple Silicon" },
	{
		tier: "8-16GB",
		modelId: "system2-labs/Qwen3.5-0.8B-TreeIsing-4bit",
		vramGb: 1,
		note: "Small specialist for high-fan-out workers",
	},
];

const HF_LARGE_MEMORY = [
	{
		tier: "24-128GB",
		modelId: "incoai/Qwen3.8-27B-Splash",
		vramGb: 18,
		note: "Flagship local model for tier-2/tier-3 duty",
	},
	{ tier: "24-128GB", modelId: "nvidia/Nemotron-3.5-Super", vramGb: 40, note: "High-context architect alternative" },
];

function largestLocalModel(models: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestGb = 0;
	for (const model of models) {
		const match = model.match(/(\d+(?:\.\d+)?)\s*b\b/i);
		if (match && parseFloat(match[1]) > bestGb) {
			bestGb = parseFloat(match[1]);
			best = model;
		}
	}
	return best;
}

/** Picks the factory memory strategy, tier-3 architect, and tier-2 worker models from local hardware and models. */
export function probeFactoryHardwareAndModels(params: {
	totalMemoryGb: number;
	availableLocalModels: readonly string[];
	hasAgyCli?: boolean;
	preferLocalTier3?: boolean;
}): HardwareModelRecommendation {
	const { totalMemoryGb, availableLocalModels } = params;
	const memoryStrategy: HardwareModelRecommendation["memoryStrategy"] =
		totalMemoryGb >= 64 ? "co-resident" : "wave-swap";

	let tier3ArchitectModel: string;
	if (params.hasAgyCli && !params.preferLocalTier3) {
		tier3ArchitectModel = "agy/gemini-3.1-pro";
	} else if (availableLocalModels.includes("lmstudio/qwen3.8-27b-splash")) {
		tier3ArchitectModel = "lmstudio/qwen3.8-27b-splash";
	} else {
		tier3ArchitectModel = largestLocalModel(availableLocalModels) ?? "lmstudio/qwen3.5-9b";
	}

	let tier2WorkerModel: string;
	if (totalMemoryGb >= 32 && availableLocalModels.includes("lmstudio/qwen3.8-27b-splash")) {
		tier2WorkerModel = "lmstudio/qwen3.8-27b-splash";
	} else if (availableLocalModels.includes("lmstudio/qwen3.5-9b")) {
		tier2WorkerModel = "lmstudio/qwen3.5-9b";
	} else if (availableLocalModels.includes("lmstudio/google/gemma-4-12b")) {
		tier2WorkerModel = "lmstudio/google/gemma-4-12b";
	} else {
		tier2WorkerModel = "lmstudio/qwen3.5-9b";
	}

	const hfRecommendations = totalMemoryGb >= 24 ? HF_LARGE_MEMORY : HF_SMALL_MEMORY;
	return { totalMemoryGb, memoryStrategy, tier3ArchitectModel, tier2WorkerModel, hfRecommendations };
}

/** Builds the lean pi CLI args that prevent 44k-token skill/context compaction loops in factory workers. */
export function buildCleanPiWorkerArgs(params: {
	modelId: string;
	prompt: string;
	provider?: string;
	lmstudioExtensionPath?: string;
}): string[] {
	return [
		"-ne",
		"-e",
		params.lmstudioExtensionPath ??
			`${homedir()}/.pi/agent/npm/node_modules/pi-lmstudio/extensions/pi-lmstudio/index.ts`,
		"--provider",
		params.provider ?? "lmstudio",
		"--model",
		params.modelId,
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--offline",
		"-p",
		params.prompt,
	];
}

export interface FactoryKanbanCard {
	id: string;
	title: string;
	allowedFiles: readonly string[];
	maxChangedLines: number;
	verifyCmd: string;
	dependsOn: readonly string[];
	exportsContract?: readonly string[];
}

/** Packs cards into sequential waves: dependencies resolve across waves, and each wave only holds file-disjoint, uncoupled cards. */
export function scheduleKanbanWaves(
	cards: readonly FactoryKanbanCard[],
	coupledPairs: readonly { cardA: string; cardB: string }[] = [],
): FactoryKanbanCard[][] {
	const remaining = new Set(cards.map((c) => c.id));
	const waves: FactoryKanbanCard[][] = [];
	while (remaining.size > 0) {
		const completed = new Set(cards.filter((c) => !remaining.has(c.id)).map((c) => c.id));
		const ready = cards.filter((c) => remaining.has(c.id) && c.dependsOn.every((d) => completed.has(d)));
		if (ready.length === 0) throw new Error("Cyclic or missing dependency in Kanban DAG");
		const wave: FactoryKanbanCard[] = [];
		const packedFiles = new Set<string>();
		for (const card of ready) {
			if (card.allowedFiles.some((f) => packedFiles.has(f))) continue;
			if (
				wave.some((w) =>
					coupledPairs.some(
						(p) => (p.cardA === w.id && p.cardB === card.id) || (p.cardB === w.id && p.cardA === card.id),
					),
				)
			)
				continue;
			wave.push(card);
			for (const file of card.allowedFiles) packedFiles.add(file);
		}
		waves.push(wave);
		for (const card of wave) remaining.delete(card.id);
	}
	return waves;
}

export interface WorkerWatchdogInput {
	cardId: string;
	workerModel: string;
	nowMs: number;
	lastProgressAtMs: number;
	maxStallMs: number;
	maxArbiterRejections?: number;
	arbiterRejections: readonly { kind: string; rule: string; filePath: string; stderrDigest: string }[];
	recentFailureHashes?: readonly string[];
	diffExcerpt?: string;
}

export interface SteeringEscalationPacket {
	cardId: string;
	workerModel: string;
	trigger: "stall_timeout" | "max_arbiter_rejections" | "repeated_failure_loop";
	stallDurationMs: number;
	rejectionsCount: number;
	summary: string;
	diffExcerpt?: string;
}

/** Trips the watchdog when a worker stalls, exhausts its arbiter rejection budget, or loops on the same failure. */
export function evaluateWorkerWatchdog(
	input: WorkerWatchdogInput,
): { healthy: true } | { healthy: false; action: "reap_and_escalate"; packet: SteeringEscalationPacket } {
	const stallDurationMs = input.nowMs - input.lastProgressAtMs;
	const rejectionsCount = input.arbiterRejections.length;
	const hashes = input.recentFailureHashes ?? [];
	const loopsOnSameFailure =
		hashes.length >= 2 && hashes[hashes.length - 1] === hashes[hashes.length - 2] && hashes[hashes.length - 1] !== "";

	let trigger: SteeringEscalationPacket["trigger"] | undefined;
	if (rejectionsCount >= (input.maxArbiterRejections ?? 2)) {
		trigger = "max_arbiter_rejections";
	} else if (loopsOnSameFailure) {
		trigger = "repeated_failure_loop";
	} else if (stallDurationMs > input.maxStallMs) {
		trigger = "stall_timeout";
	}
	if (!trigger) return { healthy: true };

	const summary =
		trigger === "max_arbiter_rejections"
			? `Worker ${input.workerModel} on card ${input.cardId} exhausted its arbiter rejection budget (${rejectionsCount} rejections).`
			: trigger === "repeated_failure_loop"
				? `Worker ${input.workerModel} on card ${input.cardId} repeated the same failure hash ${hashes[hashes.length - 1]}.`
				: `Worker ${input.workerModel} on card ${input.cardId} stalled for ${stallDurationMs}ms (limit ${input.maxStallMs}ms).`;
	return {
		healthy: false,
		action: "reap_and_escalate",
		packet: {
			cardId: input.cardId,
			workerModel: input.workerModel,
			trigger,
			stallDurationMs,
			rejectionsCount,
			summary,
			diffExcerpt: input.diffExcerpt,
		},
	};
}

/** Builds the Tier-3 Layer-Up Integrator review prompt: card contract, 1-hop neighbors, neighbor tests, prior rejections, and the worker diff. */
export function buildTier3LayerReviewPrompt(params: {
	card: FactoryKanbanCard;
	gitDiff: string;
	neighborTriples: readonly string[];
	neighborTests: readonly string[];
	arbiterRejections: readonly { kind: string; rule: string; stderrDigest: string }[];
}): string {
	const { card, gitDiff, neighborTriples, neighborTests, arbiterRejections } = params;
	const lines = [
		"Tier-3 Layer-Up Integrator review. A factory worker finished a card; verify integration coherence, not local correctness.",
		"",
		"## Card contract",
		`- id: ${card.id}`,
		`- title: ${card.title}`,
		`- allowedFiles: ${card.allowedFiles.join(", ") || "(none)"}`,
		`- maxChangedLines: ${card.maxChangedLines}`,
		`- exportsContract: ${card.exportsContract?.join(", ") || "(none)"}`,
		`- verifyCmd: ${card.verifyCmd}`,
		"",
		"## 1-hop neighbor triples (Neo4j/AtlasKV)",
		...neighborTriples.map((t) => `- ${t}`),
		"",
		"## Neighbor tests to execute",
		...neighborTests.map((t) => `- ${t}`),
		"",
		"## Prior System 2 Arbiter rejections",
		...arbiterRejections.map((r) => `- ${r.kind} / ${r.rule} / ${r.stderrDigest}`),
		"",
		"## Worker git diff",
		gitDiff,
	];
	return lines.join("\n");
}

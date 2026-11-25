// System 2 Multi-Domain Life Entourage: fleet routing, Beads-style ready queue & Neo4j Cypher,
// Splinter anti-memetics pruner & over-fencing detector, and BerriAI/Lens W3C trace correlation.
import { createHash } from "node:crypto";
import type { CypherStatement } from "./graph-store.ts";

export type LifeDomain = "work" | "side_projects" | "hobbies_life" | "weekend_lab";
export type EntourageEngine = "pi-system2" | "hermes" | "agy" | "neo4j";
export type EntouragePersona =
	| "Wanderer"
	| "Philosopher"
	| "Arbiter"
	| "Archivist"
	| "Ocular"
	| "Heretic"
	| "Chief"
	| "Splinter";
export type LifeTaskStatus = "todo" | "open" | "ready" | "in_progress" | "blocked" | "done" | "cancelled";
export type AntiMemeticsReason = "append_only_bloat" | "contradicted_rulings" | "stale_timestamp";

export interface LifeVerificationPolicy {
	mode:
		| "verify_triad_300loc"
		| "verify_splinter_doc_cap"
		| "interactive_codirector_whiteboard"
		| "experiment_log_whiteboard";
	requiresVerifyPy: boolean;
	requiresTriadReview: boolean;
	maxChangedLines: number | null;
	splinterDocCapGate: boolean;
	summary: string;
}

export interface LifeTaskInput {
	id?: string;
	title: string;
	domain: LifeDomain;
	tags?: readonly string[];
	requiresMultimodal?: boolean;
	isRecurringCron?: boolean;
	isGraphQuery?: boolean;
	preferredEngine?: EntourageEngine;
	preferredPersona?: EntouragePersona;
	standaloneMode?: boolean;
	availableEngines?: readonly EntourageEngine[];
}

export interface EntourageRouteDecision {
	taskId: string;
	domain: LifeDomain;
	engine: EntourageEngine;
	fallbackEngine: "pi-system2";
	persona: EntouragePersona;
	supportingPersonas: readonly EntouragePersona[];
	verificationPolicy: LifeVerificationPolicy;
	rationale: string;
}

export interface LifeTaskNode {
	id: string;
	title?: string;
	domain?: LifeDomain;
	status?: LifeTaskStatus;
	blockedBy?: readonly string[];
	engine?: EntourageEngine;
	persona?: EntouragePersona;
	lensTraceId?: string;
	updatedAt?: string | number;
	createdAt?: string | number;
	staleHours?: number;
}

export interface ContextDocEntry {
	path: string;
	content: string;
	maxLines?: number;
	maxTokens?: number;
	lastVerifiedAt?: string | number;
	rulesOrRulings?: readonly string[];
}

export interface AntiMemeticsAuditOptions {
	defaultMaxLines?: number;
	defaultMaxTokens?: number;
	staleThresholdDays?: number;
	nowMs?: number;
	targetModel?: string;
}

export interface AntiMemeticsFinding {
	path: string;
	reasons: readonly AntiMemeticsReason[];
	lineCount: number;
	estimatedTokens: number;
	contradictions: readonly string[];
	staleDates: readonly string[];
	recommendedAction: "prune_and_compact" | "keep";
}

export interface AntiMemeticsAuditReport {
	findings: readonly AntiMemeticsFinding[];
	requiresPruning: boolean;
	prunerPersona: "Splinter";
	workerPersona: "Wanderer";
	targetModel: string;
	estimatedTokenCostUsd: 0;
	pruningBrief: string;
}

export interface OverFencingInput {
	totalCandidateTasks: number;
	softFenceBlockedTasks: number;
	completedTasksInWindow: number;
	availableFuelBudget: number;
	softRules: readonly string[];
	blockRateThreshold?: number;
}

export interface OverFencingReport {
	overFenced: boolean;
	softBlockRatio: number;
	zeroThroughputStarvation: boolean;
	escalateToPersona: "Chief";
	auditorPersona: "Splinter";
	rulesToConvertToVerifyPy: readonly string[];
	requiresThreeStrongTests: true;
	minimumVerificationTests: 3;
	conversionGates: readonly string[];
	alertMessage: string;
}

export interface LensTraceSeedInput {
	taskId: string;
	sessionId: string;
	engine: EntourageEngine;
	persona: EntouragePersona;
	seed?: string;
	baseUrl?: string;
}

export interface LensTraceContext {
	lensTraceId: string;
	spanId: string;
	traceparent: string;
	lensUrl: string;
	sessionId: string;
	taskId: string;
}

const DOMAIN_PRIORITY: Readonly<Record<LifeDomain, number>> = {
	work: 0,
	side_projects: 1,
	weekend_lab: 2,
	hobbies_life: 3,
};

function policy(
	mode: LifeVerificationPolicy["mode"],
	requiresVerifyPy: boolean,
	requiresTriadReview: boolean,
	maxChangedLines: number | null,
	splinterDocCapGate: boolean,
	summary: string,
): LifeVerificationPolicy {
	return { mode, requiresVerifyPy, requiresTriadReview, maxChangedLines, splinterDocCapGate, summary };
}

const DOMAIN_POLICIES: Readonly<Record<LifeDomain, LifeVerificationPolicy>> = {
	work: policy("verify_triad_300loc", true, true, 300, true, "full verify.py + 3-Agent Triad + 300-LOC cap"),
	side_projects: policy("verify_splinter_doc_cap", true, false, 300, true, "verify.py + Splinter doc-cap gate"),
	hobbies_life: policy(
		"interactive_codirector_whiteboard",
		false,
		false,
		null,
		false,
		"interactive co-director / whiteboard / experiment log",
	),
	weekend_lab: policy(
		"experiment_log_whiteboard",
		false,
		false,
		null,
		false,
		"interactive co-director / whiteboard / experiment log",
	),
};

const SAFE_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const HEX_TRACE_RE = /^[0-9a-fA-F]{32}$/;

export function routeLifeTaskToEntourage(
	task: LifeTaskInput,
	options: { standaloneMode?: boolean; availableEngines?: readonly EntourageEngine[] } = {},
): EntourageRouteDecision {
	const corpus = `${task.title} ${(task.tags ?? []).join(" ")}`.toLowerCase();
	let tuple: [EntourageEngine, EntouragePersona, EntouragePersona[], string];

	if (
		task.requiresMultimodal ||
		/\b(vision|visual|image|video|frame|screenshot|diagram|ui|camera|photo|ocular|multimodal|ocr|canvas)\b/.test(
			corpus,
		)
	) {
		tuple = [
			"agy",
			"Ocular",
			["Wanderer", "Archivist"],
			"Multimodal vision & visual perception task routed to Ocular on AGY.",
		];
	} else if (
		/\b(security|red[-\s]?team|vuln|vulnerabilit\w*|exploit|adversar\w*|cve|heretic|injection)\b/.test(corpus)
	) {
		const eng: EntourageEngine = task.domain === "work" ? "pi-system2" : "agy";
		tuple = [eng, "Heretic", ["Arbiter", "Philosopher"], "Adversarial/security audit routed to Heretic."];
	} else if (/\b(anti[-\s]?memetic|prune|bloat|splinter|over[-\s]?fenc\w*|garbage)\b/.test(corpus)) {
		tuple = ["pi-system2", "Splinter", ["Wanderer", "Chief"], "Context hygiene routed to Splinter + Wanderer."];
	} else if (task.isRecurringCron || /\b(cron|schedule|hermes|briefing|inbox|telegram|reminder)\b/.test(corpus)) {
		tuple = ["hermes", "Chief", ["Archivist", "Splinter"], "Recurring Kanban briefing routed to Chief on Hermes."];
	} else if (task.isGraphQuery || /\b(neo4j|cypher)\b/.test(corpus)) {
		tuple = ["neo4j", "Archivist", ["Chief"], "Graph lineage query routed to Archivist on Neo4j."];
	} else if (task.domain === "work") {
		tuple = [
			"pi-system2",
			"Arbiter",
			["Philosopher", "Heretic", "Splinter"],
			"Work ticket routed to pi-system2 Triad.",
		];
	} else if (task.domain === "side_projects") {
		const p: EntouragePersona = /\b(arch|design|spec|rfc)\b/.test(corpus) ? "Philosopher" : "Arbiter";
		tuple = ["pi-system2", p, ["Splinter"], "Side project routed to pi-system2 with Splinter doc-cap gate."];
	} else if (task.domain === "hobbies_life") {
		const p: EntouragePersona = /\b(book|read|archive|wiki|history|notes)\b/.test(corpus) ? "Archivist" : "Wanderer";
		tuple = ["agy", p, ["Ocular"], "Hobbies/life routed to interactive co-director whiteboard."];
	} else {
		const p: EntouragePersona = /\b(stray|dream|reverie|curiosity)\b/.test(corpus) ? "Wanderer" : "Philosopher";
		tuple = ["agy", p, ["Wanderer", "Archivist"], "Weekend lab routed to Philosopher/Wanderer experiment log."];
	}

	const rawEngine = task.preferredEngine ?? tuple[0];
	const standalone = Boolean(task.standaloneMode ?? options.standaloneMode);
	const allowed = task.availableEngines ?? options.availableEngines;
	const resolvedEngine: EntourageEngine =
		standalone || (allowed && !allowed.includes(rawEngine)) ? "pi-system2" : rawEngine;

	return {
		taskId: task.id ?? "life-task-unassigned",
		domain: task.domain,
		engine: resolvedEngine,
		fallbackEngine: "pi-system2",
		persona: task.preferredPersona ?? tuple[1],
		supportingPersonas: tuple[2],
		verificationPolicy: DOMAIN_POLICIES[task.domain],
		rationale: tuple[3],
	};
}

function toTimestampMs(val: string | number | undefined): number {
	if (typeof val === "number" && Number.isFinite(val)) return val;
	const parsed = typeof val === "string" ? Date.parse(val) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

export function findReadyLifeTasks(tasks: readonly LifeTaskNode[]): LifeTaskNode[] {
	const taskMap = new Map(tasks.map((t) => [t.id, t]));
	const visitState = new Map<string, 0 | 1 | 2>();
	const satisfiedMemo = new Map<string, boolean>();

	function isDependencySatisfied(id: string): boolean {
		const state = visitState.get(id) ?? 0;
		if (state === 1) return false;
		if (state === 2) return satisfiedMemo.get(id) ?? false;
		visitState.set(id, 1);
		const node = taskMap.get(id);
		const ok =
			Boolean(node && node.status === "done") &&
			(node?.blockedBy ?? []).every((parentId) => parentId !== id && isDependencySatisfied(parentId));
		visitState.set(id, 2);
		satisfiedMemo.set(id, ok);
		return ok;
	}

	return tasks
		.filter((task) => {
			const status = task.status ?? "todo";
			if (status !== "todo" && status !== "open" && status !== "ready") return false;
			return (task.blockedBy ?? []).every((depId) => depId !== task.id && isDependencySatisfied(depId));
		})
		.sort((a, b) => {
			const domDiff = DOMAIN_PRIORITY[a.domain ?? "work"] - DOMAIN_PRIORITY[b.domain ?? "work"];
			if (domDiff !== 0) return domDiff;
			const staleDiff = (b.staleHours ?? 0) - (a.staleHours ?? 0);
			if (staleDiff !== 0) return staleDiff;
			const timeDiff = toTimestampMs(a.updatedAt ?? a.createdAt) - toTimestampMs(b.updatedAt ?? b.createdAt);
			return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
		});
}

export function buildLifeGraphCypher(tasks: readonly LifeTaskNode[]): CypherStatement[] {
	const statements: CypherStatement[] = [];
	for (const task of tasks) {
		statements.push({
			statement:
				"MERGE (t:LifeTask {id: $id}) SET t.title = $title, t.domain = $domain, t.status = $status, t.engine = $engine, t.persona = $persona, t.lensTraceId = $lensTraceId",
			parameters: {
				id: task.id,
				title: task.title ?? task.id,
				domain: task.domain ?? "work",
				status: task.status ?? "todo",
				engine: task.engine ?? "pi-system2",
				persona: task.persona ?? "Arbiter",
				lensTraceId: task.lensTraceId ?? null,
			},
		});
		for (const blockerId of task.blockedBy ?? []) {
			statements.push({
				statement:
					"MERGE (blocker:LifeTask {id: $blockerId}) MERGE (blocked:LifeTask {id: $blockedId}) MERGE (blocker)-[:BLOCKS]->(blocked)",
				parameters: { blockerId, blockedId: task.id },
			});
		}
	}
	return statements;
}

function detectContradictions(content: string, explicitRules: readonly string[] = []): string[] {
	const positiveSubjects = new Map<string, string>();
	const negativeSubjects = new Map<string, string>();
	const contradictions: string[] = [];

	for (const raw of [...content.split(/\r?\n/), ...explicitRules]) {
		const line = raw.trim();
		if (!line) continue;
		if (/\[(SUPERSEDED|CONTRADICTED|OBSOLETE)\]/i.test(line)) {
			contradictions.push(`Superseded ruling retained: "${line}"`);
		}
		const pos = line.match(/\b(?:ALWAYS|MUST|REQUIRED(?:\s+TO)?)\s+(?:use|enable|run|enforce)\s+([a-z0-9_.-]+)/i);
		if (pos) positiveSubjects.set(pos[1].toLowerCase(), line);
		const neg = line.match(
			/\b(?:NEVER|MUST\s+NOT|DO\s+NOT|FORBIDDEN(?:\s+TO)?|DEPRECATED:?)\s+(?:use|enable|run|enforce)?\s*([a-z0-9_.-]+)/i,
		);
		if (neg) negativeSubjects.set(neg[1].toLowerCase(), line);
	}
	for (const [subject, posLine] of positiveSubjects) {
		const negLine = negativeSubjects.get(subject);
		if (negLine) contradictions.push(`Conflicting rulings on "${subject}": "${posLine}" vs "${negLine}"`);
	}
	return contradictions;
}

export function auditContextAntiMemetics(
	docs: readonly ContextDocEntry[],
	options: AntiMemeticsAuditOptions = {},
): AntiMemeticsAuditReport {
	const defaultMaxLines = options.defaultMaxLines ?? 150;
	const defaultMaxTokens = options.defaultMaxTokens ?? 1200;
	const staleCutoffMs = (options.nowMs ?? Date.now()) - (options.staleThresholdDays ?? 30) * 86_400_000;
	const targetModel = options.targetModel ?? "qwen3.6-35b-a3b-splash";

	const findings: AntiMemeticsFinding[] = docs.map((doc) => {
		const lineCount = doc.content.length === 0 ? 0 : doc.content.split(/\r?\n/).length;
		const estimatedTokens = Math.ceil(doc.content.length / 4);
		const reasons: AntiMemeticsReason[] = [];
		if (lineCount > (doc.maxLines ?? defaultMaxLines) || estimatedTokens > (doc.maxTokens ?? defaultMaxTokens)) {
			reasons.push("append_only_bloat");
		}
		const contradictions = detectContradictions(doc.content, doc.rulesOrRulings);
		if (contradictions.length > 0) reasons.push("contradicted_rulings");

		const staleDates: string[] = [];
		const verifiedMs = toTimestampMs(doc.lastVerifiedAt);
		if (verifiedMs > 0 && verifiedMs < staleCutoffMs) staleDates.push(String(doc.lastVerifiedAt));
		for (const dateStr of doc.content.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? []) {
			const parsed = Date.parse(dateStr);
			if (!Number.isNaN(parsed) && parsed < staleCutoffMs && !staleDates.includes(dateStr)) staleDates.push(dateStr);
		}
		if (staleDates.length > 0) reasons.push("stale_timestamp");
		const recommendedAction = reasons.length > 0 ? "prune_and_compact" : "keep";
		return { path: doc.path, reasons, lineCount, estimatedTokens, contradictions, staleDates, recommendedAction };
	});

	const flagged = findings.filter((f) => f.recommendedAction === "prune_and_compact");
	const requiresPruning = flagged.length > 0;
	const summary = flagged.map((f) => `${f.path} [${f.reasons.join(", ")}]`).join("; ");
	return {
		findings,
		requiresPruning,
		prunerPersona: "Splinter",
		workerPersona: "Wanderer",
		targetModel,
		estimatedTokenCostUsd: 0,
		pruningBrief: requiresPruning
			? `[Splinter Anti-Memetics Brief -> Wanderer (${targetModel}, $0 local cost)]: Prune ${flagged.length} bloated/stale doc(s): ${summary}.`
			: `[Splinter Anti-Memetics Brief -> Wanderer (${targetModel}, $0 local cost)]: All ${docs.length} context doc(s) within budget.`,
	};
}

export const OVER_FENCING_CONVERSION_GATES = [
	"1_deterministic_verify_py_check_passes",
	"2_three_adversarial_falsification_tests_pass",
	"3_splinter_and_arbiter_signoff_before_fence_removal",
] as const;

export function detectOverFencing(input: OverFencingInput): OverFencingReport {
	const total = Math.max(0, input.totalCandidateTasks);
	const blocked = Math.max(0, Math.min(total, input.softFenceBlockedTasks));
	const softBlockRatio = total > 0 ? blocked / total : 0;
	const hasFences = blocked > 0 || input.softRules.length > 0;
	const zeroThroughputStarvation =
		total > 0 && input.completedTasksInWindow <= 0 && input.availableFuelBudget > 0 && hasFences;
	const overFenced =
		(total > 0 && softBlockRatio >= (input.blockRateThreshold ?? 0.5) && hasFences) || zeroThroughputStarvation;
	const rulesToConvertToVerifyPy = overFenced ? [...input.softRules] : [];

	return {
		overFenced,
		softBlockRatio,
		zeroThroughputStarvation,
		escalateToPersona: "Chief",
		auditorPersona: "Splinter",
		rulesToConvertToVerifyPy,
		requiresThreeStrongTests: true,
		minimumVerificationTests: 3,
		conversionGates: OVER_FENCING_CONVERSION_GATES,
		alertMessage: overFenced
			? `[Splinter -> Chief OVER-FENCING ALERT]: Soft Block Ratio ${(softBlockRatio * 100).toFixed(0)}% (${blocked}/${total}). Convert ${rulesToConvertToVerifyPy.length} soft CYA rule(s) into deterministic verify.py checks and delete the soft fences ONLY after passing all 3 conversion gates (>= 3 strong adversarial tests).`
			: `[Splinter -> Chief]: Workspace fencing healthy (${(softBlockRatio * 100).toFixed(0)}%).`,
	};
}

export function formatLensTraceUrl(lensTraceId: string, baseUrl = "http://localhost:4318"): string {
	const trimmed = lensTraceId.trim();
	if (!HEX_TRACE_RE.test(trimmed) || /^0+$/.test(trimmed)) {
		throw new Error(`Invalid lensTraceId "${lensTraceId}": must be a non-zero 32-char hex W3C trace ID`);
	}
	const parsed = new URL(baseUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported Lens baseUrl protocol "${parsed.protocol}"`);
	}
	return `${baseUrl.replace(/\/+$/, "")}/ui/traces/${trimmed.toLowerCase()}`;
}

export function createLensTraceContext(input: LensTraceSeedInput): LensTraceContext {
	if (!SAFE_ID_RE.test(input.taskId)) throw new Error(`Invalid taskId "${input.taskId}"`);
	if (!SAFE_ID_RE.test(input.sessionId)) throw new Error(`Invalid sessionId "${input.sessionId}"`);
	const digest = createHash("sha256")
		.update(`${input.taskId}:${input.sessionId}:${input.engine}:${input.persona}:${input.seed ?? ""}`, "utf8")
		.digest("hex");
	const lensTraceId = /^0+$/.test(digest.slice(0, 32)) ? `${"0".repeat(31)}1` : digest.slice(0, 32);
	const spanId = /^0+$/.test(digest.slice(32, 48)) ? `${"0".repeat(15)}1` : digest.slice(32, 48);
	return {
		lensTraceId,
		spanId,
		traceparent: `00-${lensTraceId}-${spanId}-01`,
		lensUrl: formatLensTraceUrl(lensTraceId, input.baseUrl),
		sessionId: input.sessionId,
		taskId: input.taskId,
	};
}

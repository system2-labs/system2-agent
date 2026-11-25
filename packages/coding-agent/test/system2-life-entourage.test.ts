import { describe, expect, it } from "vitest";
import {
	auditContextAntiMemetics,
	buildLifeGraphCypher,
	createLensTraceContext,
	detectOverFencing,
	findReadyLifeTasks,
	formatLensTraceUrl,
	type LifeTaskNode,
	routeLifeTaskToEntourage,
} from "../src/core/system2/life-entourage.ts";

describe("Multi-Domain Life Entourage Router (routeLifeTaskToEntourage)", () => {
	it("routes work tickets to pi-system2 + Arbiter with full verify.py + 3-Agent Triad + 300-LOC cap", () => {
		const route = routeLifeTaskToEntourage({
			id: "S2-FAC-07",
			title: "Implement deterministic Kanban ready queue in TypeScript",
			domain: "work",
			tags: ["backend", "system2"],
		});
		expect(route.engine).toBe("pi-system2");
		expect(route.persona).toBe("Arbiter");
		expect(route.verificationPolicy.mode).toBe("verify_triad_300loc");
		expect(route.verificationPolicy.requiresVerifyPy).toBe(true);
		expect(route.verificationPolicy.requiresTriadReview).toBe(true);
		expect(route.verificationPolicy.maxChangedLines).toBe(300);
	});

	it("routes general multimodal vision, UI screenshot, diagram, and photo tasks to Ocular on AGY", () => {
		const uiVisionRoute = routeLifeTaskToEntourage({
			id: "VISION-UI-01",
			title: "Inspect architecture diagram and UI screenshot for layout regressions",
			domain: "work",
			tags: ["vision", "screenshot"],
		});
		expect(uiVisionRoute.engine).toBe("agy");
		expect(uiVisionRoute.persona).toBe("Ocular");

		const hobbyPhotoRoute = routeLifeTaskToEntourage({
			id: "PHOTO-01",
			title: "Review camera photo frame exposure and visual balance",
			domain: "hobbies_life",
		});
		expect(hobbyPhotoRoute.engine).toBe("agy");
		expect(hobbyPhotoRoute.persona).toBe("Ocular");
		expect(hobbyPhotoRoute.verificationPolicy.mode).toBe("interactive_codirector_whiteboard");
		expect(hobbyPhotoRoute.verificationPolicy.requiresVerifyPy).toBe(false);
		expect(hobbyPhotoRoute.verificationPolicy.requiresTriadReview).toBe(false);
	});

	it("routes security and adversarial audits to Heretic", () => {
		const workSec = routeLifeTaskToEntourage({
			id: "SEC-01",
			title: "Red-team Cypher injection and shell boundary vulnerabilities",
			domain: "work",
		});
		expect(workSec.persona).toBe("Heretic");
		expect(workSec.engine).toBe("pi-system2");
		expect(workSec.verificationPolicy.requiresTriadReview).toBe(true);

		const labSec = routeLifeTaskToEntourage({
			id: "SEC-LAB-02",
			title: "Adversarial prompt exploit probe in sandbox",
			domain: "weekend_lab",
		});
		expect(labSec.persona).toBe("Heretic");
		expect(labSec.engine).toBe("agy");
	});

	it("routes recurring cron / Kanban briefings to Hermes + Chief and side projects to Splinter doc-cap gate", () => {
		const cronRoute = routeLifeTaskToEntourage({
			id: "HERMES-CRON-1",
			title: "Morning Hermes Kanban ready-queue briefing on Telegram",
			domain: "side_projects",
			isRecurringCron: true,
		});
		expect(cronRoute.engine).toBe("hermes");
		expect(cronRoute.persona).toBe("Chief");
		expect(cronRoute.verificationPolicy.mode).toBe("verify_splinter_doc_cap");
		expect(cronRoute.verificationPolicy.splinterDocCapGate).toBe(true);
		expect(cronRoute.verificationPolicy.requiresTriadReview).toBe(false);
	});

	it("routes Neo4j dependency graph queries and Splinter anti-memetics tasks accurately", () => {
		const graphRoute = routeLifeTaskToEntourage({
			id: "GRAPH-01",
			title: "Run Neo4j Cypher lineage query across blocked tasks",
			domain: "side_projects",
			isGraphQuery: true,
		});
		expect(graphRoute.engine).toBe("neo4j");
		expect(graphRoute.persona).toBe("Archivist");

		const splinterRoute = routeLifeTaskToEntourage({
			id: "SPLINTER-01",
			title: "Prune append-only doc bloat and audit over-fencing rules",
			domain: "work",
		});
		expect(splinterRoute.engine).toBe("pi-system2");
		expect(splinterRoute.persona).toBe("Splinter");
		expect(splinterRoute.fallbackEngine).toBe("pi-system2");

		const standaloneRoute = routeLifeTaskToEntourage(
			{
				id: "STANDALONE-01",
				title: "Morning Hermes Kanban ready-queue briefing on Telegram",
				domain: "side_projects",
				isRecurringCron: true,
			},
			{ standaloneMode: true },
		);
		expect(standaloneRoute.engine).toBe("pi-system2");
		expect(standaloneRoute.fallbackEngine).toBe("pi-system2");
	});
});

describe("Beads-Style Dependency Ready Queue & Neo4j Cypher Sync", () => {
	it("returns only unblocked leaf tasks sorted by domain priority and staleness", () => {
		const tasks: LifeTaskNode[] = [
			{
				id: "T-DONE",
				title: "Foundation schema",
				domain: "work",
				status: "done",
				blockedBy: [],
			},
			{
				id: "T-HOBBY-READY",
				title: "Curate street photo selects",
				domain: "hobbies_life",
				status: "todo",
				blockedBy: [],
				staleHours: 48,
			},
			{
				id: "T-WORK-FRESH",
				title: "Build router",
				domain: "work",
				status: "todo",
				blockedBy: ["T-DONE"],
				staleHours: 4,
			},
			{
				id: "T-WORK-STALE",
				title: "Fix urgent regression",
				domain: "work",
				status: "todo",
				blockedBy: ["T-DONE"],
				staleHours: 24,
			},
			{
				id: "T-SIDE-READY",
				title: "Polish CLI",
				domain: "side_projects",
				status: "todo",
				blockedBy: ["T-DONE"],
				staleHours: 12,
			},
			{
				id: "T-BLOCKED",
				title: "Downstream integration",
				domain: "work",
				status: "todo",
				blockedBy: ["T-WORK-FRESH"],
			},
		];

		const ready = findReadyLifeTasks(tasks);
		expect(ready.map((t) => t.id)).toEqual(["T-WORK-STALE", "T-WORK-FRESH", "T-SIDE-READY", "T-HOBBY-READY"]);
	});

	it("terminates cleanly and excludes deadlocked tasks on cyclic or transitive unfinished dependencies", () => {
		const cyclicTasks: LifeTaskNode[] = [
			{ id: "A", title: "Cycle A", domain: "work", status: "todo", blockedBy: ["B"] },
			{ id: "B", title: "Cycle B", domain: "work", status: "todo", blockedBy: ["A"] },
			{ id: "C", title: "Depends on cycle", domain: "work", status: "todo", blockedBy: ["A"] },
			{ id: "SELF", title: "Self loop", domain: "work", status: "todo", blockedBy: ["SELF"] },
			{ id: "TRANS-1", title: "Root unfinished", domain: "work", status: "in_progress", blockedBy: [] },
			{ id: "TRANS-2", title: "Prematurely done mid node", domain: "work", status: "done", blockedBy: ["TRANS-1"] },
			{ id: "TRANS-3", title: "Leaf with unfinished root", domain: "work", status: "todo", blockedBy: ["TRANS-2"] },
			{ id: "CLEAN", title: "Valid ready task", domain: "weekend_lab", status: "todo", blockedBy: [] },
		];

		const ready = findReadyLifeTasks(cyclicTasks);
		expect(ready.map((t) => t.id)).toEqual(["CLEAN"]);
	});

	it("generates strictly parameterized Neo4j Cypher statements for LifeTask nodes and BLOCKS edges", () => {
		const tasks: LifeTaskNode[] = [
			{
				id: "S2-01",
				title: "Base spec'; MATCH (n) DETACH DELETE n; //",
				domain: "work",
				status: "done",
				engine: "pi-system2",
				persona: "Arbiter",
				lensTraceId: "a".repeat(32),
			},
			{
				id: "S2-02",
				title: "Follow-up task",
				domain: "side_projects",
				status: "todo",
				blockedBy: ["S2-01"],
			},
		];

		const cypher = buildLifeGraphCypher(tasks);
		expect(cypher).toHaveLength(3);
		expect(cypher[0].statement).toContain("MERGE (t:LifeTask {id: $id})");
		expect(cypher[0].statement).not.toContain("DETACH DELETE");
		expect(cypher[0].parameters?.title).toContain("DETACH DELETE");
		expect(cypher[2].statement).toBe(
			"MERGE (blocker:LifeTask {id: $blockerId}) MERGE (blocked:LifeTask {id: $blockedId}) MERGE (blocker)-[:BLOCKS]->(blocked)",
		);
		expect(cypher[2].parameters).toEqual({ blockerId: "S2-01", blockedId: "S2-02" });
	});
});

describe("Splinter — Head of Anti-Memetics & Over-Fencing Detector", () => {
	it("detects append-only bloat, contradicted rulings, and stale timestamps and emits a $0 Wanderer pruning brief", () => {
		const nowMs = Date.parse("2026-11-25T00:00:00Z");
		const bloatedContent = [
			"# AGENTS.md — Historical Ledger",
			"Last updated: 2025-01-10",
			"Rule 1: ALWAYS use neo4j_http_v1 for graph persistence.",
			"Rule 2: [SUPERSEDED] Old worker timeout policy.",
			"Rule 3: NEVER use neo4j_http_v1 in production runs.",
			...Array.from({ length: 45 }, (_, i) => `Append-only log entry #${i + 1}`),
		].join("\n");

		const report = auditContextAntiMemetics(
			[
				{
					path: "docs/AGENTS_LEDGER.md",
					content: bloatedContent,
					maxLines: 25,
					maxTokens: 200,
					lastVerifiedAt: "2025-01-10",
				},
				{
					path: "docs/CLEAN.md",
					content: "# Concise Truth\nVerified: 2026-11-24\nKeep modules under 300 lines.",
					maxLines: 50,
					maxTokens: 500,
				},
			],
			{ nowMs, staleThresholdDays: 30 },
		);

		expect(report.requiresPruning).toBe(true);
		expect(report.prunerPersona).toBe("Splinter");
		expect(report.workerPersona).toBe("Wanderer");
		expect(report.targetModel).toBe("qwen3.6-35b-a3b-splash");
		expect(report.estimatedTokenCostUsd).toBe(0);

		const bloatedFinding = report.findings.find((f) => f.path === "docs/AGENTS_LEDGER.md");
		expect(bloatedFinding?.recommendedAction).toBe("prune_and_compact");
		expect(bloatedFinding?.reasons).toEqual(["append_only_bloat", "contradicted_rulings", "stale_timestamp"]);
		expect(bloatedFinding?.contradictions.length).toBeGreaterThanOrEqual(2);

		const cleanFinding = report.findings.find((f) => f.path === "docs/CLEAN.md");
		expect(cleanFinding?.recommendedAction).toBe("keep");
		expect(report.pruningBrief).toContain("qwen3.6-35b-a3b-splash");
		expect(report.pruningBrief).toContain("$0");
	});

	it("detects over-fencing on high block rates or zero-throughput starvation and avoids division-by-zero on empty queues", () => {
		const emptyReport = detectOverFencing({
			totalCandidateTasks: 0,
			softFenceBlockedTasks: 0,
			completedTasksInWindow: 0,
			availableFuelBudget: 100,
			softRules: [],
		});
		expect(emptyReport.overFenced).toBe(false);
		expect(emptyReport.softBlockRatio).toBe(0);
		expect(Number.isNaN(emptyReport.softBlockRatio)).toBe(false);

		const fencedReport = detectOverFencing({
			totalCandidateTasks: 10,
			softFenceBlockedTasks: 7,
			completedTasksInWindow: 0,
			availableFuelBudget: 500,
			softRules: ["DO NOT modify system2 files without manual review", "NEVER touch test fixtures on weekdays"],
		});
		expect(fencedReport.overFenced).toBe(true);
		expect(fencedReport.softBlockRatio).toBeCloseTo(0.7, 5);
		expect(fencedReport.zeroThroughputStarvation).toBe(true);
		expect(fencedReport.escalateToPersona).toBe("Chief");
		expect(fencedReport.auditorPersona).toBe("Splinter");
		expect(fencedReport.rulesToConvertToVerifyPy).toHaveLength(2);
		expect(fencedReport.requiresThreeStrongTests).toBe(true);
		expect(fencedReport.minimumVerificationTests).toBe(3);
		expect(fencedReport.conversionGates).toEqual([
			"1_deterministic_verify_py_check_passes",
			"2_three_adversarial_falsification_tests_pass",
			"3_splinter_and_arbiter_signoff_before_fence_removal",
		]);
		expect(fencedReport.alertMessage).toContain("verify.py");
	});
});

describe("BerriAI/Lens ClickHouse Trace Correlation", () => {
	it("creates deterministic W3C trace context and formats ClickHouse/Lens investigation deep-links", () => {
		const ctx1 = createLensTraceContext({
			taskId: "S2-FAC-07",
			sessionId: "sess_20261125_entourage",
			engine: "pi-system2",
			persona: "Arbiter",
			seed: "round-1",
		});
		const ctx2 = createLensTraceContext({
			taskId: "S2-FAC-07",
			sessionId: "sess_20261125_entourage",
			engine: "pi-system2",
			persona: "Arbiter",
			seed: "round-1",
		});

		expect(ctx1).toEqual(ctx2);
		expect(ctx1.lensTraceId).toMatch(/^[0-9a-f]{32}$/);
		expect(ctx1.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(ctx1.traceparent).toBe(`00-${ctx1.lensTraceId}-${ctx1.spanId}-01`);
		expect(ctx1.lensUrl).toBe(`http://localhost:4318/ui/traces/${ctx1.lensTraceId}`);
	});

	it("rejects malformed or injection-tainted lensTraceId and sessionId inputs", () => {
		expect(() => formatLensTraceUrl("0".repeat(32))).toThrow(/Invalid lensTraceId/);
		expect(() => formatLensTraceUrl("../../etc/passwd")).toThrow(/Invalid lensTraceId/);
		expect(() =>
			createLensTraceContext({
				taskId: "S2-FAC-07",
				sessionId: "bad session; rm -rf /",
				engine: "pi-system2",
				persona: "Arbiter",
			}),
		).toThrow(/Invalid sessionId/);
	});
});

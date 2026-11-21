import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ApprovedStackLock,
	buildCleanPiWorkerArgs,
	buildTier3LayerReviewPrompt,
	detectUnderspecifiedStack,
	evaluateWorkerWatchdog,
	type FactoryKanbanCard,
	probeFactoryHardwareAndModels,
	scheduleKanbanWaves,
	verifyCommandAgainstStackLock,
	verifySourceImportsAgainstStackLock,
} from "../src/core/system2/factory.ts";
import { collectFactoryTargetFiles, runFactoryCliCommand } from "../src/core/system2/factory-cli.ts";

const LOCK: ApprovedStackLock = {
	allowedPackages: ["zod", "lmstudio", "@factory/common"],
	allowNewDependencies: false,
};

describe("detectUnderspecifiedStack", () => {
	it("triggers on a vague agent+RAG goal with vetted options and doc URLs", () => {
		const result = detectUnderspecifiedStack("build an agent system with RAG");
		expect(result.needsClarification).toBe(true);
		expect(result.missingCategories).toContain("agent_framework");
		expect(result.missingCategories).toContain("rag_or_graph");
		for (const category of result.missingCategories) {
			const options = result.optionsByCategory[category];
			expect(options.length).toBeGreaterThanOrEqual(4);
			expect(options.length).toBeLessThanOrEqual(5);
			for (const option of options) {
				expect(option.name).toBeTruthy();
				expect(option.docsUrl).toMatch(/^https:\/\//);
			}
		}
	});

	it("does not trigger when the stack is already named", () => {
		const result = detectUnderspecifiedStack("build an agent system with RAG, Use Neo4j and System2");
		expect(result.needsClarification).toBe(false);
		expect(result.missingCategories).toEqual([]);
	});

	it("does not trigger when existing packages cover the category", () => {
		const result = detectUnderspecifiedStack("add retrieval for docs", ["neo4j-driver"]);
		expect(result.needsClarification).toBe(false);
	});
});

describe("stack lock gates", () => {
	it("allows approved installs and bare install flags", () => {
		expect(verifyCommandAgainstStackLock("npm install zod", LOCK).allowed).toBe(true);
		expect(verifyCommandAgainstStackLock("npm install", LOCK).allowed).toBe(true);
		expect(verifyCommandAgainstStackLock("npm install -D", LOCK).allowed).toBe(true);
		expect(verifyCommandAgainstStackLock("pnpm add @factory/common@1.0.0", LOCK).allowed).toBe(true);
	});

	it("blocks rogue installs, stripping version suffixes", () => {
		const verdict = verifyCommandAgainstStackLock("npm install langchain@0.3.0", LOCK);
		expect(verdict.allowed).toBe(false);
		expect(verdict.violationPackage).toBe("langchain");
		expect(verdict.reason).toContain("ApprovedStackLock");
	});

	it("allows approved imports and node built-ins, blocks rogue imports", () => {
		expect(
			verifySourceImportsAgainstStackLock(
				'import fs from "node:fs";\nimport path from "path";\nimport { z } from "zod";\nrequire("@factory/common/sub")',
				LOCK,
			).allowed,
		).toBe(true);
		const verdict = verifySourceImportsAgainstStackLock('import { agent } from "unapproved-sdk";', LOCK);
		expect(verdict.allowed).toBe(false);
		expect(verdict.violationPackage).toBe("unapproved-sdk");
		expect(verifySourceImportsAgainstStackLock('import { x } from "./local";', LOCK).allowed).toBe(true);
	});

	it("passes everything when new dependencies are allowed", () => {
		const open: ApprovedStackLock = { allowedPackages: [], allowNewDependencies: true };
		expect(verifyCommandAgainstStackLock("npm install langchain", open).allowed).toBe(true);
		expect(verifySourceImportsAgainstStackLock('from "langchain"', open).allowed).toBe(true);
	});
});

describe("hardware probe and lean worker CLI", () => {
	it("selects co-resident on 128GB and the agy architect when available", () => {
		const rec = probeFactoryHardwareAndModels({ totalMemoryGb: 128, availableLocalModels: [], hasAgyCli: true });
		expect(rec.memoryStrategy).toBe("co-resident");
		expect(rec.tier3ArchitectModel).toBe("agy/gemini-3.1-pro");
		expect(rec.hfRecommendations.some((r) => r.modelId === "incoai/Qwen3.8-27B-Splash")).toBe(true);
	});

	it("prefers the local 27B splash model for both tiers", () => {
		const rec = probeFactoryHardwareAndModels({
			totalMemoryGb: 96,
			availableLocalModels: ["lmstudio/qwen3.8-27b-splash"],
		});
		expect(rec.memoryStrategy).toBe("co-resident");
		expect(rec.tier3ArchitectModel).toBe("lmstudio/qwen3.8-27b-splash");
		expect(rec.tier2WorkerModel).toBe("lmstudio/qwen3.8-27b-splash");
		expect(rec.memoryStrategy).toBe("co-resident");
	});

	it("falls back to wave-swap with a small default worker on 16GB", () => {
		const rec = probeFactoryHardwareAndModels({ totalMemoryGb: 16, availableLocalModels: [] });
		expect(rec.memoryStrategy).toBe("wave-swap");
		expect(rec.tier2WorkerModel).toBe("lmstudio/qwen3.5-9b");
		expect(rec.hfRecommendations.every((r) => r.tier === "8-16GB")).toBe(true);
	});

	it("builds lean worker args without skills or context files", () => {
		const args = buildCleanPiWorkerArgs({ modelId: "qwen3.5-9b", prompt: "do the task" });
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-context-files");
		expect(args).toContain("--offline");
		expect(args).toContain("--no-session");
		expect(args.at(-1)).toBe("do the task");
		expect(args[args.length - 2]).toBe("-p");
	});
});

describe("scheduleKanbanWaves", () => {
	function card(id: string, files: string[], dependsOn: string[] = []): FactoryKanbanCard {
		return { id, title: id, allowedFiles: files, maxChangedLines: 50, verifyCmd: `npm test -- ${id}`, dependsOn };
	}

	it("splits file-sharing cards into consecutive waves and packs disjoint cards together", () => {
		const waves = scheduleKanbanWaves([card("a", ["x.ts"]), card("b", ["x.ts"]), card("c", ["y.ts"])]);
		expect(waves[0].map((c) => c.id).sort()).toEqual(["a", "c"]);
		expect(waves[1].map((c) => c.id)).toEqual(["b"]);
	});

	it("schedules dependents in later waves", () => {
		const waves = scheduleKanbanWaves([card("a", ["x.ts"]), card("b", ["y.ts"], ["a"])]);
		expect(waves[0].map((c) => c.id)).toEqual(["a"]);
		expect(waves[1].map((c) => c.id)).toEqual(["b"]);
	});

	it("splits coupled pairs into separate waves", () => {
		const waves = scheduleKanbanWaves([card("a", ["x.ts"]), card("b", ["y.ts"])], [{ cardA: "a", cardB: "b" }]);
		expect(waves.length).toBe(2);
	});

	it("throws on a dependency cycle", () => {
		expect(() => scheduleKanbanWaves([card("a", ["x.ts"], ["b"]), card("b", ["y.ts"], ["a"])])).toThrow(
			"Cyclic or missing dependency in Kanban DAG",
		);
	});
});

describe("watchdog and tier-3 layer review", () => {
	const base = {
		cardId: "card-1",
		workerModel: "lmstudio/qwen3.5-9b",
		nowMs: 10_000,
		lastProgressAtMs: 9_000,
		maxStallMs: 5_000,
		arbiterRejections: [],
	};

	it("stays healthy when fresh, under rejection budget, and without failure loops", () => {
		expect(evaluateWorkerWatchdog({ ...base, recentFailureHashes: ["h1", "h2"] }).healthy).toBe(true);
	});

	it("trips on stall timeout with an escalation packet", () => {
		const verdict = evaluateWorkerWatchdog({ ...base, nowMs: 20_000 });
		expect(verdict.healthy).toBe(false);
		if (!verdict.healthy) {
			expect(verdict.action).toBe("reap_and_escalate");
			expect(verdict.packet.trigger).toBe("stall_timeout");
			expect(verdict.packet.stallDurationMs).toBe(11_000);
			expect(verdict.packet.summary).toContain("card-1");
		}
	});

	it("trips on 2 arbiter rejections (default budget)", () => {
		const verdict = evaluateWorkerWatchdog({
			...base,
			arbiterRejections: [
				{ kind: "x", rule: "r", filePath: "f", stderrDigest: "d" },
				{ kind: "x", rule: "r", filePath: "f", stderrDigest: "d" },
			],
		});
		expect(verdict.healthy).toBe(false);
		if (!verdict.healthy) expect(verdict.packet.trigger).toBe("max_arbiter_rejections");
	});

	it("trips on a repeated identical failure hash", () => {
		const verdict = evaluateWorkerWatchdog({ ...base, recentFailureHashes: ["abc", "abc"] });
		expect(verdict.healthy).toBe(false);
		if (!verdict.healthy) expect(verdict.packet.trigger).toBe("repeated_failure_loop");
	});

	it("builds a complete layer-up integrator prompt", () => {
		const prompt = buildTier3LayerReviewPrompt({
			card: {
				id: "card-1",
				title: "Add parser",
				allowedFiles: ["src/parser.ts"],
				maxChangedLines: 40,
				verifyCmd: "npm test",
				dependsOn: [],
				exportsContract: ["parseThing"],
			},
			gitDiff: "diff --git a/src/parser.ts b/src/parser.ts\n+parseThing",
			neighborTriples: ["(parser)-[:EXPORTS]->(parseThing)"],
			neighborTests: ["npm test -- parser"],
			arbiterRejections: [{ kind: "syntax", rule: "no-dynamic-import", stderrDigest: "unexpected token" }],
		});
		expect(prompt).toContain("card-1");
		expect(prompt).toContain("src/parser.ts");
		expect(prompt).toContain("exportsContract: parseThing");
		expect(prompt).toContain("npm test");
		expect(prompt).toContain("(parser)-[:EXPORTS]->(parseThing)");
		expect(prompt).toContain("no-dynamic-import");
		expect(prompt).toContain("diff --git");
	});
});

describe("system2 factory CLI subcommand (runFactoryCliCommand)", () => {
	it(" executes status, scan, plan, and review directly against a workspace directory", async () => {
		const ws = mkdtempSync(join(tmpdir(), "s2-factory-cli-"));
		writeFileSync(join(ws, "bus.py"), "class EventBus:\n    def publish(self, topic, msg):\n        return topic\n");
		writeFileSync(
			join(ws, "test_bus.py"),
			"from bus import EventBus\ndef test_publish():\n    b = EventBus()\n    assert b.publish('a', 1) == 'a'\n",
		);
		try {
			const files = collectFactoryTargetFiles(ws, []);
			expect(files).toEqual(["bus.py", "test_bus.py"]);

			const statusLines: string[] = [];
			expect(await runFactoryCliCommand(["status", "--json"], { cwd: ws, stdout: (s) => statusLines.push(s) })).toBe(
				0,
			);
			const statusJson = JSON.parse(statusLines.join("\n"));
			expect(statusJson.cwd).toBe(ws);
			expect(statusJson.hardware.tier2WorkerModel).toBeTruthy();

			const scanLines: string[] = [];
			expect(await runFactoryCliCommand(["scan", "--json"], { cwd: ws, stdout: (s) => scanLines.push(s) })).toBe(0);
			const scanJson = JSON.parse(scanLines.join("\n"));
			expect(scanJson.filesScanned).toBe(2);
			expect(scanJson.symbolsUpserted).toBeGreaterThanOrEqual(2);

			const planLines: string[] = [];
			expect(
				await runFactoryCliCommand(["plan", "Build an agent with RAG over EventBus", "--json"], {
					cwd: ws,
					stdout: (s) => planLines.push(s),
				}),
			).toBe(0);
			const planJson = JSON.parse(planLines.join("\n"));
			expect(planJson.stackDiscovery.needsClarification).toBe(true);
			expect(planJson.waves.length).toBeGreaterThan(0);

			const reviewLines: string[] = [];
			expect(await runFactoryCliCommand(["review", "--json"], { cwd: ws, stdout: (s) => reviewLines.push(s) })).toBe(
				0,
			);
			const reviewJson = JSON.parse(reviewLines.join("\n"));
			expect(reviewJson.neighborTests).toContain("test_bus.py");
			expect(reviewJson.reviewPrompt).toContain("Layer-Up Contract Review");

			// Interactive Tier-3 Architect chat session (`system2 factory chat`) + `/lock` + `/quit`
			const chatOut: string[] = [];
			const fakeInputs = ["/status", "/lock pytest,neo4j", "/quit"];
			let inputIdx = 0;
			expect(
				await runFactoryCliCommand(["chat", "--local-tier3"], {
					cwd: ws,
					stdout: (s) => chatOut.push(s),
					promptLine: async () => fakeInputs[inputIdx++],
				}),
			).toBe(0);
			const joinedChat = chatOut.join("\n");
			expect(joinedChat).toContain("Interactive Tier-3 Architect Session");
			expect(joinedChat).toContain("Locked StackLock");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});

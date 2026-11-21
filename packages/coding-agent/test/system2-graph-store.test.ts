import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KanbanCardNode } from "../src/core/system2/graph-store.ts";
import { extractFileContracts, System2GraphStore } from "../src/core/system2/graph-store.ts";

const TS_A = `import { helper } from "./b";
export function run() {
	return helper();
}
`;

const TS_B = `export function helper() {
	return 1;
}
`;

const PY_C = `import os
from utils.helper import clamp

def scale(x: int) -> int:
	return clamp(x)

class Model:
	pass
`;

function makeCard(id: string, allowedFiles: string[]): KanbanCardNode {
	return {
		id,
		runId: "run-1",
		title: id,
		status: "todo",
		allowedFiles,
		maxChangedLines: 50,
		verifyCmd: "vitest run",
		dependsOn: [],
	};
}

function mockFetch() {
	const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			body: typeof init?.body === "string" ? init.body : "",
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		return new Response(JSON.stringify({ results: [], errors: [] }), { status: 200 });
	}) as typeof fetch;
	return { calls, fetchImpl };
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "s2-graph-store-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("extractFileContracts", () => {
	it("extracts symbols, imports, calls, and defines edges from TypeScript", () => {
		const result = extractFileContracts("src/a.ts", TS_A);
		expect(result.symbols.map((s) => s.name)).toContain("run");
		expect(result.symbols[0].id).toBe("src/a.ts::run");
		expect(result.symbols[0].kind).toBe("function");
		expect(result.symbols[0].signature).toBe("export function run()");
		expect(result.edges.some((e) => e.kind === "DEFINES" && e.to === "src/a.ts::run")).toBe(true);
		expect(result.edges.some((e) => e.kind === "IMPORTS" && e.to === "./b")).toBe(true);
		expect(result.edges.some((e) => e.kind === "CALLS" && e.to === "helper")).toBe(true);
	});

	it("extracts symbols and imports from Python", () => {
		const result = extractFileContracts("src/c.py", PY_C);
		expect(result.symbols.map((s) => s.name).sort()).toEqual(["Model", "scale"]);
		expect(result.edges.some((e) => e.kind === "IMPORTS" && e.to === "os")).toBe(true);
		expect(result.edges.some((e) => e.kind === "IMPORTS" && e.to === "utils.helper")).toBe(true);
	});

	it("emits COVERED_BY instead of IMPORTS for test files", () => {
		const result = extractFileContracts("src/a.test.ts", `import { run } from "./a";\nrun();\n`, true);
		expect(result.edges.some((e) => e.kind === "COVERED_BY" && e.to === "./a")).toBe(true);
		expect(result.edges.every((e) => e.kind !== "IMPORTS")).toBe(true);
	});
});

describe("System2GraphStore", () => {
	it("detects coupled kanban cards via shared files and 1-hop symbol coupling", async () => {
		const { fetchImpl } = mockFetch();
		const store = new System2GraphStore({
			fallbackJsonPath: join(dir, "g.json"),
			fetchImpl,
			preferOfflineJson: true,
		});
		await store.upsertCodeContracts([
			{ path: "src/a.ts", content: TS_A },
			{ path: "src/b.ts", content: TS_B },
		]);
		await store.upsertKanbanCards("run-1", [
			makeCard("card-a", ["src/a.ts"]),
			makeCard("card-b", ["src/b.ts"]),
			makeCard("card-c", ["src/b.ts"]),
		]);
		const pairs = await store.findCoupledCards("run-1");
		const cardA = pairs.filter((p) => p.cardA === "card-a" || p.cardB === "card-a");
		expect(cardA.some((p) => p.reason === "coupled_symbol_1hop")).toBe(true);
		expect(pairs.some((p) => p.reason === "shared_file" && p.cardA === "card-b" && p.cardB === "card-c")).toBe(true);
	});

	it("builds adjacent-layer contract triples, neighbor tests, and prior rejections", async () => {
		const { fetchImpl } = mockFetch();
		const store = new System2GraphStore({
			fallbackJsonPath: join(dir, "g.json"),
			fetchImpl,
			preferOfflineJson: true,
		});
		await store.upsertCodeContracts([
			{ path: "src/a.ts", content: TS_A },
			{ path: "src/b.ts", content: TS_B },
			{ path: "src/a.test.ts", content: `import { run } from "./a";\nrun();`, isTest: true },
		]);
		await store.upsertKanbanCards("run-1", [makeCard("card-a", ["src/a.ts"])]);
		await store.recordArbiterRejection({
			id: "rej-1",
			cardId: "card-a",
			modelId: "model-1",
			kind: "ScopeViolation",
			rule: "file-not-allowed",
			filePath: "src/other.ts",
			stderrDigest: "digest-1",
			timestamp: 1,
		});
		const ctx = await store.getAdjacentLayerContext("card-a");
		expect(ctx.touchedFiles).toEqual(["src/a.ts"]);
		expect(ctx.neighborTriples.some((t) => t.includes("src/a.ts::run") && t.includes("helper"))).toBe(true);
		expect(ctx.neighborTests).toContain("src/a.test.ts");
		expect(ctx.priorRejections).toHaveLength(1);
		expect(ctx.priorRejections[0].kind).toBe("ScopeViolation");
	});

	it("formats Neo4j HTTP Cypher transactions with auth and syncs online", async () => {
		const { calls, fetchImpl } = mockFetch();
		const store = new System2GraphStore({
			fallbackJsonPath: join(dir, "g.json"),
			fetchImpl,
		});
		const result = await store.upsertCodeContracts([{ path: "src/a.ts", content: TS_A }]);
		expect(result.backend).toBe("neo4j");
		expect(calls.length).toBeGreaterThan(0);
		const expectedAuth = `Basic ${Buffer.from("neo4j:password123").toString("base64")}`;
		expect(calls.every((c) => c.headers.Authorization === expectedAuth)).toBe(true);
		expect(calls.every((c) => c.headers["Content-Type"] === "application/json")).toBe(true);
		const tx = JSON.parse(calls[calls.length - 1].body) as {
			statements: { statement: string; parameters?: Record<string, unknown> }[];
		};
		expect(tx.statements.length).toBeGreaterThan(0);
		expect(tx.statements.every((s) => s.statement.startsWith("MERGE"))).toBe(true);
		expect(
			tx.statements.some(
				(s) => s.statement.includes("MERGE (f:S2File {path: $path}") && s.parameters?.id === "src/a.ts::run",
			),
		).toBe(true);
	});

	it("falls back to local JSON when Neo4j is offline and hydrates from it", async () => {
		const failingFetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		const jsonPath = join(dir, "g.json");
		const store = new System2GraphStore({ fallbackJsonPath: jsonPath, fetchImpl: failingFetch });
		const result = await store.upsertCodeContracts([{ path: "src/c.py", content: PY_C }]);
		expect(result.backend).toBe("json");
		expect(existsSync(jsonPath)).toBe(true);
		await store.upsertKanbanCards("run-1", [makeCard("card-a", ["src/c.py"])]);
		const snapshot = JSON.parse(readFileSync(jsonPath, "utf8")) as {
			symbols: { id: string }[];
			cards: { id: string }[];
		};
		expect(snapshot.symbols.map((s) => s.id)).toContain("src/c.py::scale");
		expect(snapshot.cards.map((c) => c.id)).toContain("card-a");
		const rehydrated = new System2GraphStore({
			fallbackJsonPath: jsonPath,
			fetchImpl: failingFetch,
			preferOfflineJson: true,
		});
		const ctx = await rehydrated.getAdjacentLayerContext("card-a");
		expect(ctx.touchedFiles).toEqual(["src/c.py"]);
		expect(await rehydrated.findCoupledCards("run-1")).toEqual([]);
	});
});

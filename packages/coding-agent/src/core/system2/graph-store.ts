/**
 * System 2 factory graph store: dual-backend graph over Neo4j 5.x HTTP Cypher
 * with a zero-config local JSON fallback, plus a fast regex-based contract
 * extractor for TypeScript and Python sources.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CodeSymbolNode {
	id: string;
	name: string;
	filePath: string;
	kind: "function" | "class" | "interface" | "type" | "variable";
	signature: string;
	exported: boolean;
}

export interface CodeEdge {
	from: string;
	to: string;
	kind: "DEFINES" | "IMPORTS" | "CALLS" | "COVERED_BY";
}

export interface KanbanCardNode {
	id: string;
	runId: string;
	title: string;
	status: "todo" | "in_progress" | "arbiter_blocked" | "layer_review" | "done";
	allowedFiles: readonly string[];
	maxChangedLines: number;
	verifyCmd: string;
	dependsOn: readonly string[];
	exportsContract?: readonly string[];
}

export interface ArbiterRejectionEvent {
	id: string;
	cardId: string;
	modelId: string;
	kind: "CaperRollback" | "LeanGuardDeny" | "ScopeViolation" | "StackLockDeny";
	rule: string;
	filePath: string;
	symbolName?: string;
	stderrDigest: string;
	timestamp: number;
}

export interface CoupledCardPair {
	cardA: string;
	cardB: string;
	reason: "shared_file" | "coupled_symbol_1hop";
	details: readonly string[];
}

export interface AdjacentLayerContext {
	cardId: string;
	touchedFiles: readonly string[];
	neighborTriples: readonly string[];
	neighborTests: readonly string[];
	priorRejections: readonly ArbiterRejectionEvent[];
}

export interface GraphStoreOptions {
	neo4jHttpUrl?: string;
	neo4jUser?: string;
	neo4jPassword?: string;
	fallbackJsonPath?: string;
	preferOfflineJson?: boolean;
	fetchImpl?: typeof fetch;
}

export interface CypherStatement {
	statement: string;
	parameters?: Record<string, unknown>;
}

interface GraphState {
	symbols: Map<string, CodeSymbolNode>;
	edges: CodeEdge[];
	cards: Map<string, KanbanCardNode>;
	rejections: ArbiterRejectionEvent[];
}

interface GraphSnapshot {
	symbols: CodeSymbolNode[];
	edges: CodeEdge[];
	cards: KanbanCardNode[];
	rejections: ArbiterRejectionEvent[];
}

interface Neo4jHttpPayload {
	errors?: { message?: string }[];
}

interface FileContracts {
	symbols: CodeSymbolNode[];
	edges: CodeEdge[];
}

const TS_SYMBOL_PATTERNS: readonly { pattern: RegExp; kind: CodeSymbolNode["kind"] }[] = [
	{ pattern: /export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g, kind: "function" },
	{ pattern: /export\s+class\s+(\w+)/g, kind: "class" },
	{ pattern: /export\s+interface\s+(\w+)/g, kind: "interface" },
	{ pattern: /export\s+type\s+(\w+)/g, kind: "type" },
	{ pattern: /export\s+const\s+(\w+)/g, kind: "variable" },
];

const PYTHON_SYMBOL_PATTERNS: readonly { pattern: RegExp; kind: CodeSymbolNode["kind"] }[] = [
	{ pattern: /\bdef\s+(\w+)\s*\([^)]*\)/g, kind: "function" },
	{ pattern: /\bclass\s+(\w+)/g, kind: "class" },
];

const TS_IMPORT_PATTERN = /import\s+(?:(type\s+)?([\s\S]+?)\s+from\s+)?["']([^"']+)["']/g;
const PYTHON_IMPORT_PATTERN = /(?:from\s+([\w.]+)\s+import\s+([^;\n]+)|import\s+([\w.]+(?:\s+as\s+\w+)?))/g;
const CALL_PATTERN = /([A-Za-z_]\w*)\s*\(/g;

/**
 * Extracts symbol nodes and graph edges (DEFINES, IMPORTS/COVERED_BY, CALLS)
 * from one TS/JS/Python source text via lightweight regex scans, not a full AST.
 */
export function extractFileContracts(filePath: string, sourceText: string, isTestFile = false): FileContracts {
	const isPython = filePath.endsWith(".py");
	const symbols: CodeSymbolNode[] = [];
	for (const { pattern, kind } of isPython ? PYTHON_SYMBOL_PATTERNS : TS_SYMBOL_PATTERNS) {
		for (const match of sourceText.matchAll(pattern)) {
			const node: CodeSymbolNode = {
				id: `${filePath}::${match[1]}`,
				name: match[1],
				filePath,
				kind,
				signature: match[0].replace(/\s+/g, " ").trim(),
				exported: !isPython,
			};
			if (!symbols.some((s) => s.id === node.id)) symbols.push(node);
		}
	}

	const edges: CodeEdge[] = symbols.map((s) => ({ from: filePath, to: s.id, kind: "DEFINES" as CodeEdge["kind"] }));
	const importKind: CodeEdge["kind"] = isTestFile ? "COVERED_BY" : "IMPORTS";
	const importPattern = isPython ? PYTHON_IMPORT_PATTERN : TS_IMPORT_PATTERN;
	const importedNames = new Set<string>();
	for (const match of sourceText.matchAll(importPattern)) {
		const target = isPython ? (match[1] ?? match[3]) : match[3];
		if (!target) continue;
		edges.push({ from: filePath, to: target, kind: importKind });
		// Bindings introduced by the import clause ("{ helper }", "foo, { bar }", "* as ns").
		const specifiers = (match[2] ?? "").replace(/\btype\b/g, "");
		for (const nameMatch of specifiers.matchAll(/[\w$]+/g)) importedNames.add(nameMatch[0]);
		// Plain "import os [as x]" binds the module (or alias) as a local name.
		if (isPython && !match[2] && match[1]) importedNames.add(match[1].split(/\s+as\s+/).pop() ?? "");
	}

	// CALLS: identifiers invoked in this file that are known symbols here or imported bindings.
	const called = new Set<string>();
	for (const match of sourceText.matchAll(CALL_PATTERN)) called.add(match[1]);
	for (const name of called) {
		if (symbols.some((s) => s.name === name) || importedNames.has(name)) {
			edges.push({ from: filePath, to: name, kind: "CALLS" });
		}
	}
	return { symbols, edges };
}

/**
 * In-memory factory graph, mirrored to a local JSON file on every mutation
 * and synced to Neo4j HTTP Cypher whenever the database is reachable.
 */
export class System2GraphStore {
	private readonly neo4jHttpUrl: string;
	private readonly neo4jUser: string;
	private readonly neo4jPassword: string;
	private readonly fallbackJsonPath: string;
	private readonly preferOfflineJson: boolean;
	private readonly fetchImpl: typeof fetch;
	private readonly state: GraphState = { symbols: new Map(), edges: [], cards: new Map(), rejections: [] };

	constructor(options: GraphStoreOptions = {}) {
		this.neo4jHttpUrl =
			options.neo4jHttpUrl ?? process.env.NEO4J_HTTP_URL ?? "http://127.0.0.1:7474/db/neo4j/tx/commit";
		this.neo4jUser = options.neo4jUser ?? process.env.NEO4J_USER ?? "neo4j";
		this.neo4jPassword = options.neo4jPassword ?? process.env.NEO4J_PASSWORD ?? "password123";
		this.fallbackJsonPath = options.fallbackJsonPath ?? ".system2/factory-graph.json";
		this.preferOfflineJson = options.preferOfflineJson ?? false;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.hydrateFromFallback();
	}

	private hydrateFromFallback(): void {
		if (!existsSync(this.fallbackJsonPath)) return;
		try {
			const snapshot = JSON.parse(readFileSync(this.fallbackJsonPath, "utf8")) as GraphSnapshot;
			this.state.symbols = new Map((snapshot.symbols ?? []).map((s) => [s.id, s]));
			this.state.edges = [...(snapshot.edges ?? [])];
			this.state.cards = new Map((snapshot.cards ?? []).map((c) => [c.id, c]));
			this.state.rejections = [...(snapshot.rejections ?? [])];
		} catch {
			// Corrupt fallback file: start from an empty graph rather than crash the factory.
		}
	}

	private persistFallback(): void {
		const snapshot: GraphSnapshot = {
			symbols: [...this.state.symbols.values()],
			edges: [...this.state.edges],
			cards: [...this.state.cards.values()],
			rejections: [...this.state.rejections],
		};
		mkdirSync(path.dirname(this.fallbackJsonPath), { recursive: true });
		writeFileSync(this.fallbackJsonPath, JSON.stringify(snapshot, null, 2));
	}

	private authHeader(): string {
		return `Basic ${Buffer.from(`${this.neo4jUser}:${this.neo4jPassword}`).toString("base64")}`;
	}

	/**
	 * Reports whether the Neo4j HTTP endpoint answers with a clean `RETURN 1`
	 * within 800 ms; never throws, and is always false in offline mode.
	 */
	async pingNeo4j(): Promise<boolean> {
		if (this.preferOfflineJson) return false;
		try {
			const res = await this.fetchImpl(this.neo4jHttpUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: this.authHeader() },
				body: JSON.stringify({ statements: [{ statement: "RETURN 1 AS ok" }] }),
				signal: AbortSignal.timeout(800),
			});
			if (!res.ok) return false;
			const payload = (await res.json()) as Neo4jHttpPayload;
			return payload.errors === undefined || payload.errors.length === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Sends statements to Neo4j when reachable; returns false (graceful JSON
	 * fallback) instead of throwing when the graph database is offline.
	 */
	async executeCypher(statements: readonly CypherStatement[]): Promise<boolean> {
		if (!(await this.pingNeo4j())) return false;
		try {
			const res = await this.fetchImpl(this.neo4jHttpUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: this.authHeader() },
				body: JSON.stringify({ statements }),
			});
			if (!res.ok) return false;
			const payload = (await res.json()) as Neo4jHttpPayload;
			return payload.errors === undefined || payload.errors.length === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Ingests source files: extracts contracts into the in-memory graph, always
	 * persists the JSON fallback, and syncs MERGE statements to Neo4j online.
	 */
	async upsertCodeContracts(
		files: readonly { path: string; content: string; isTest?: boolean }[],
	): Promise<{ symbolsUpserted: number; edgesUpserted: number; backend: "neo4j" | "json" }> {
		const seenSymbols = new Set<string>();
		const seenEdges = new Set<string>();
		const statements: CypherStatement[] = [];
		for (const file of files) {
			const { symbols, edges } = extractFileContracts(file.path, file.content, file.isTest === true);
			for (const symbol of symbols) {
				if (seenSymbols.has(symbol.id)) continue;
				seenSymbols.add(symbol.id);
				this.state.symbols.set(symbol.id, symbol);
				statements.push({
					statement:
						"MERGE (f:S2File {path: $path}) MERGE (s:S2Symbol {id: $id}) SET s.name = $name, s.signature = $sig, s.filePath = $filePath MERGE (f)-[:DEFINES]->(s)",
					parameters: {
						path: file.path,
						id: symbol.id,
						name: symbol.name,
						sig: symbol.signature,
						filePath: file.path,
					},
				});
			}
			for (const edge of edges) {
				const key = `${edge.kind}:${edge.from}->${edge.to}`;
				if (seenEdges.has(key)) continue;
				seenEdges.add(key);
				this.state.edges.push(edge);
				const toFile = edge.to.includes("::") ? edge.to.slice(0, edge.to.indexOf("::")) : edge.to;
				statements.push({
					statement: `MERGE (a:S2File {path: $from}) MERGE (b:S2File {path: $to}) MERGE (a)-[:${edge.kind}]->(b)`,
					parameters: { from: edge.from, to: toFile },
				});
			}
		}
		this.persistFallback();
		const synced = statements.length > 0 && (await this.executeCypher(statements));
		return { symbolsUpserted: seenSymbols.size, edgesUpserted: seenEdges.size, backend: synced ? "neo4j" : "json" };
	}

	/**
	 * Stores kanban cards in memory + JSON fallback and syncs them to Neo4j
	 * when the graph database is reachable.
	 */
	async upsertKanbanCards(runId: string, cards: readonly KanbanCardNode[]): Promise<void> {
		const statements: CypherStatement[] = [];
		for (const card of cards) {
			this.state.cards.set(card.id, card);
			statements.push({
				statement: "MERGE (c:S2KanbanCard {id: $id}) SET c.runId = $runId, c.title = $title, c.status = $status",
				parameters: { id: card.id, runId, title: card.title, status: card.status },
			});
		}
		this.persistFallback();
		await this.executeCypher(statements);
	}

	/**
	 * Records an arbiter rejection in memory + JSON fallback and syncs the
	 * event node to Neo4j when reachable.
	 */
	async recordArbiterRejection(event: ArbiterRejectionEvent): Promise<void> {
		this.state.rejections.push(event);
		this.persistFallback();
		await this.executeCypher([
			{
				statement:
					"MERGE (e:S2ArbiterEvent {id: $id}) SET e.cardId = $cardId, e.kind = $kind, e.rule = $rule, e.filePath = $filePath",
				parameters: {
					id: event.id,
					cardId: event.cardId,
					kind: event.kind,
					rule: event.rule,
					filePath: event.filePath,
				},
			},
		]);
	}

	/**
	 * Finds card pairs in a run that cannot run in parallel: shared allowed
	 * files, or 1-hop coupling via IMPORTS/CALLS edges between their files.
	 */
	async findCoupledCards(runId: string): Promise<CoupledCardPair[]> {
		const cards = [...this.state.cards.values()].filter((c) => c.runId === runId);
		const pairs: CoupledCardPair[] = [];
		for (let i = 0; i < cards.length; i++) {
			for (let j = i + 1; j < cards.length; j++) {
				const a = cards[i];
				const b = cards[j];
				const shared = a.allowedFiles.filter((f) => b.allowedFiles.includes(f));
				if (shared.length > 0) {
					pairs.push({ cardA: a.id, cardB: b.id, reason: "shared_file", details: shared });
					continue;
				}
				const coupled = this.coupledSymbols(a, b);
				if (coupled.length > 0)
					pairs.push({ cardA: a.id, cardB: b.id, reason: "coupled_symbol_1hop", details: coupled });
			}
		}
		return pairs;
	}

	/**
	 * Builds the 1-hop context around a card's allowed files for the Layer-2
	 * reviewer: contract triples, adjacent tests, and prior arbiter rejections.
	 */
	async getAdjacentLayerContext(cardId: string): Promise<AdjacentLayerContext> {
		const card = this.state.cards.get(cardId);
		if (!card) {
			return { cardId, touchedFiles: [], neighborTriples: [], neighborTests: [], priorRejections: [] };
		}
		const touched = new Set(card.allowedFiles);
		const touchedSymbolNames = this.definedSymbolNames(touched);
		const touches = (target: string): boolean => {
			const file = target.includes("::") ? target.slice(0, target.indexOf("::")) : target;
			if (touched.has(file) || touchedSymbolNames.has(target)) return true;
			for (const touchedFile of touched) {
				if (this.fileRefMatches(file, touchedFile)) return true;
			}
			return false;
		};
		const neighborTriples: string[] = [];
		const neighborTests: string[] = [];
		const seenTest = new Set<string>();
		for (const edge of this.state.edges) {
			if (edge.kind !== "IMPORTS" && edge.kind !== "CALLS" && edge.kind !== "COVERED_BY") continue;
			if (touched.has(edge.from)) {
				for (const symbol of this.state.symbols.values()) {
					if (symbol.filePath !== edge.from) continue;
					const triple = `(${symbol.id} [${symbol.signature}]) -[${edge.kind}]-> (${edge.to})`;
					if (!neighborTriples.includes(triple)) neighborTriples.push(triple);
				}
			}
			if (touches(edge.to) && (edge.kind === "COVERED_BY" || this.isTestFile(edge.from))) {
				if (!seenTest.has(edge.from)) {
					seenTest.add(edge.from);
					neighborTests.push(edge.from);
				}
			}
		}
		const priorRejections = this.state.rejections.filter(
			(r) => r.cardId === cardId || card.allowedFiles.includes(r.filePath),
		);
		return { cardId, touchedFiles: card.allowedFiles, neighborTriples, neighborTests, priorRejections };
	}

	private definedSymbolNames(files: Set<string>): Set<string> {
		const names = new Set<string>();
		for (const symbol of this.state.symbols.values()) {
			if (files.has(symbol.filePath)) names.add(symbol.name);
		}
		return names;
	}

	private isTestFile(filePath: string): boolean {
		return /\.(test|spec)\.[cm]?[jt]s$|(^|\/)test_[^/]*\.py$|(^|\/)__tests__\//.test(filePath);
	}

	private fileRefMatches(ref: string, file: string): boolean {
		// Relative import targets usually omit the extension ("./a" vs "src/a.ts").
		const norm = (s: string) => s.replace(/^\.\//, "").replace(/\.[cm]?[jt]s$|\.py$/, "");
		const a = norm(ref);
		const b = norm(file);
		return a === b || a === b.split("/").pop() || b.endsWith(`/${a}`);
	}

	private coupledSymbols(a: KanbanCardNode, b: KanbanCardNode): string[] {
		const filesA = new Set(a.allowedFiles);
		const filesB = new Set(b.allowedFiles);
		const namesA = this.definedSymbolNames(filesA);
		const namesB = this.definedSymbolNames(filesB);
		const fileHits = (ref: string, files: Set<string>): string | undefined => {
			for (const f of files) if (this.fileRefMatches(ref, f)) return f;
			return undefined;
		};
		const coupled = new Set<string>();
		for (const edge of this.state.edges) {
			if (edge.kind !== "IMPORTS" && edge.kind !== "CALLS") continue;
			const name = edge.to.includes("::") ? edge.to.slice(edge.to.indexOf("::") + 2) : edge.to;
			if (filesA.has(edge.from) && (fileHits(edge.to, filesB) !== undefined || namesB.has(name))) {
				coupled.add(fileHits(edge.to, filesB) ?? name);
			}
			if (filesB.has(edge.from) && (fileHits(edge.to, filesA) !== undefined || namesA.has(name))) {
				coupled.add(fileHits(edge.to, filesA) ?? name);
			}
		}
		return [...coupled];
	}
}

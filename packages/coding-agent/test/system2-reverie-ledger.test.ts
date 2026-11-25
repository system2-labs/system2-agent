import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ForensicAuditBlock,
	ReverieBlock,
	ReverieOrigin,
	ReverieProofOfWork,
} from "../src/core/system2/reverie-ledger.ts";
import {
	appendReverieBlockToFile,
	buildReverieNeo4jStatements,
	buildRoundtableKanbanSeed,
	buildSessionCallbackPacket,
	computeReverieBlockHash,
	decryptBreakGlassAuditPayload,
	decryptForensicPayload,
	encryptForensicPayload,
	GENESIS_PREV_HASH,
	mintForensicAuditBlock,
	mintReverieBlock,
	promoteReverieToKanbanTask,
	queryRoundtablePitches,
	readReverieChainFromFile,
	recordRoundtableDecision,
	sealBreakGlassAuditPayload,
	validateProofOfWork,
	verifyForensicAuditChain,
	verifyReverieChain,
} from "../src/core/system2/reverie-ledger.ts";

const CLEAN_POW: ReverieProofOfWork = {
	ticketSlug: "S2-FAC-05-reverie-ledger",
	commitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
	verifyPassedRound: 1,
	docsUpdated: true,
	specPath: "runs/S2-FAC-05-reverie-ledger/spec.toml",
};

const SAMPLE_ORIGIN: ReverieOrigin = {
	engine: "pi-system2",
	persona: "Architect",
	sessionId: "sess-pi-2026-11-25-001",
	transcriptPath: "/logs/sess-pi-2026-11-25-001.jsonl",
	lensTraceId: "4bf92f3577b34da6a3ce929d0e0e4736",
};

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "s2-reverie-ledger-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("Plane 1 vs Plane 2 Proof-of-Verification Gate", () => {
	it("mints a valid genesis ReverieBlock when proofOfWork passes first-round verification", () => {
		expect(validateProofOfWork(CLEAN_POW)).toBe(true);
		const genesis = mintReverieBlock({
			proofOfWork: CLEAN_POW,
			origin: SAMPLE_ORIGIN,
			timestamp: "2026-11-25T08:00:00.000Z",
			payload: {
				kind: "whiteboard_coaching",
				domain: "ci-cd",
				title: "Zero-flake GitHub Actions DAG cache",
				pitch: "Whiteboard with TJ on content-addressable Nix/Bun layer caching for CI.",
				tags: ["ci-cd", "whiteboard"],
			},
		});

		expect(genesis.blockHeight).toBe(0);
		expect(genesis.prevHash).toBe(GENESIS_PREV_HASH);
		expect(genesis.blockHash).toMatch(/^[0-9a-f]{64}$/);
		expect(genesis.payload.status).toBe("pitched");
	});

	it("produces identical SHA-256 blockHash regardless of key insertion order", () => {
		const timestamp = "2026-11-25T08:00:00.000Z";
		const b1 = mintReverieBlock({
			proofOfWork: {
				ticketSlug: "S2-FAC-05",
				commitSha: "deadbeef1234",
				verifyPassedRound: 1,
				docsUpdated: true,
			},
			origin: {
				engine: "agy",
				persona: "Ocular",
				sessionId: "sess-01",
				lensTraceId: "trace-99",
			},
			timestamp,
			payload: {
				kind: "open_forum",
				domain: "vision-ui",
				pitch: "Explore multimodal layout tree diffing on canvas snapshots.",
			},
		});

		const reorderedDraft: Omit<ReverieBlock, "blockHash"> = {
			timestamp,
			prevHash: GENESIS_PREV_HASH,
			blockHeight: 0,
			payload: {
				status: "pitched",
				pitch: "Explore multimodal layout tree diffing on canvas snapshots.",
				domain: "vision-ui",
				kind: "open_forum",
			},
			origin: {
				lensTraceId: "trace-99",
				sessionId: "sess-01",
				persona: "Ocular",
				engine: "agy",
			},
			proofOfWork: {
				docsUpdated: true,
				verifyPassedRound: 1,
				commitSha: "deadbeef1234",
				ticketSlug: "S2-FAC-05",
			},
		};

		expect(computeReverieBlockHash(reorderedDraft)).toBe(b1.blockHash);
	});

	it("rejects minting when verifyPassedRound > 1, docsUpdated is false, or commitSha/ticketSlug is invalid", () => {
		expect(() =>
			mintReverieBlock({
				proofOfWork: { ...CLEAN_POW, verifyPassedRound: 2 },
				origin: SAMPLE_ORIGIN,
				payload: { kind: "stray_thought", pitch: "Multi-bounce run attempt" },
			}),
		).toThrow(/verifyPassedRound must be 1/);

		expect(() =>
			mintReverieBlock({
				proofOfWork: { ...CLEAN_POW, docsUpdated: false },
				origin: SAMPLE_ORIGIN,
				payload: { kind: "stray_thought", pitch: "Skipped docs attempt" },
			}),
		).toThrow(/docsUpdated must be true/);

		expect(() =>
			mintReverieBlock({
				proofOfWork: { ...CLEAN_POW, commitSha: "not-a-hex-sha!" },
				origin: SAMPLE_ORIGIN,
				payload: { kind: "stray_thought", pitch: "Bad commit SHA" },
			}),
		).toThrow(/commitSha/);

		expect(() =>
			mintReverieBlock({
				proofOfWork: { ...CLEAN_POW, ticketSlug: "   " },
				origin: SAMPLE_ORIGIN,
				payload: { kind: "stray_thought", pitch: "Blank ticket slug" },
			}),
		).toThrow(/ticketSlug/);
	});
});

describe("SHA-256 Hash Chain & Tamper Detection", () => {
	function buildFiveBlockChain(): ReverieBlock[] {
		const topics = [
			{ kind: "whiteboard_coaching" as const, domain: "api", pitch: "Pitch 0: GraphQL federation latency budget" },
			{ kind: "stray_thought" as const, domain: "quantum", pitch: "Pitch 1: Topological qubit error correction" },
			{ kind: "open_forum" as const, domain: "vision", pitch: "Pitch 2: Multimodal screenshot diffing pipeline" },
			{ kind: "experiment" as const, domain: "climate", pitch: "Pitch 3: Ocean alkalinity sensor telemetry" },
			{
				kind: "open_forum" as const,
				domain: "book-club",
				pitch: "Pitch 4: Designing Data-Intensive Applications ch 9",
			},
		];
		const chain: ReverieBlock[] = [];
		for (let i = 0; i < topics.length; i++) {
			const block = mintReverieBlock({
				prevBlock: chain[i - 1],
				proofOfWork: { ...CLEAN_POW, ticketSlug: `S2-FAC-0${i + 1}` },
				origin: { ...SAMPLE_ORIGIN, sessionId: `sess-00${i + 1}` },
				timestamp: `2026-11-25T08:0${i}:00.000Z`,
				payload: topics[i],
			});
			chain.push(block);
		}
		return chain;
	}

	it("verifies a valid 5-block chain and detects 1-byte mutation in a middle block", () => {
		const chain = buildFiveBlockChain();
		expect(verifyReverieChain(chain)).toEqual({ valid: true });

		const tampered = chain.map((b, idx) =>
			idx === 2
				? {
						...b,
						payload: {
							...b.payload,
							pitch: `${b.payload.pitch.slice(0, -1)}X`,
						},
					}
				: b,
		);
		const result = verifyReverieChain(tampered);
		expect(result.valid).toBe(false);
		expect(result.tamperedBlockHeight).toBe(2);
		expect(result.reason).toMatch(/blockHash mismatch at blockHeight 2/);
	});

	it("detects genesis prevHash corruption, broken prevHash links, and non-contiguous blockHeight", () => {
		const chain = buildFiveBlockChain();

		const badGenesis = [{ ...chain[0], prevHash: "f".repeat(64) }, ...chain.slice(1)];
		expect(verifyReverieChain(badGenesis)).toMatchObject({ valid: false, tamperedBlockHeight: 0 });

		const brokenLink = chain.map((b, idx) => (idx === 3 ? { ...b, prevHash: "1".repeat(64) } : b));
		expect(verifyReverieChain(brokenLink)).toMatchObject({ valid: false, tamperedBlockHeight: 3 });

		const gapHeight = chain.map((b, idx) => (idx === 1 ? { ...b, blockHeight: 9 } : b));
		expect(verifyReverieChain(gapHeight)).toMatchObject({ valid: false, tamperedBlockHeight: 1 });
	});

	it("persists and reloads JSONL chains while handling missing parent dirs and missing trailing newlines", () => {
		const chain = buildFiveBlockChain();
		const ledgerPath = join(tempDir, "nested", "ledger", "reverie.jsonl");
		expect(readReverieChainFromFile(ledgerPath)).toEqual([]);

		appendReverieBlockToFile(ledgerPath, chain[0]);
		writeFileSync(ledgerPath, JSON.stringify(chain[0]), "utf8");
		appendReverieBlockToFile(ledgerPath, chain[1]);

		const loaded = readReverieChainFromFile(ledgerPath);
		expect(loaded).toHaveLength(2);
		expect(verifyReverieChain(loaded)).toEqual({ valid: true });

		expect(() => appendReverieBlockToFile(ledgerPath, chain[4])).toThrow(/Cannot append invalid Reverie block/);
	});
});

describe("Nightly / EOD Roundtable, Kanban Positive Data Flywheel & Neo4j Cypher Export", () => {
	it("defaults to nightly cadence, supports end_of_day / friday_night / weekend_deep_dive, and builds Kanban flywheel seeds", () => {
		const b0 = mintReverieBlock({
			proofOfWork: CLEAN_POW,
			origin: SAMPLE_ORIGIN,
			timestamp: "2026-11-25T09:00:00.000Z",
			payload: {
				kind: "whiteboard_coaching",
				domain: "architecture",
				title: "ClickHouse trace rollup index",
				pitch: "Whiteboard MaterializedView partitioning for BerriAI/lens traces.",
				tags: ["clickhouse", "lens"],
			},
		});
		const b1 = mintReverieBlock({
			prevBlock: b0,
			proofOfWork: CLEAN_POW,
			origin: {
				engine: "hermes",
				persona: "Splinter",
				sessionId: "sess-hermes-splinter-77",
				lensTraceId: "99aabbccddeeff001122334455667788",
			},
			timestamp: "2026-11-25T09:05:00.000Z",
			payload: {
				kind: "experiment",
				domain: "weekend_lab",
				title: "Proof-Carrying Fence Tombstones",
				pitch: "Verify retired AGENTS.md rules stay backed by 3 deterministic unit tests.",
				tags: ["splinter", "anti-memetics"],
			},
		});

		const initialChain = [b0, b1];
		expect(queryRoundtablePitches(initialChain, { status: "pitched" })).toHaveLength(2);

		const nightlyScheduled = recordRoundtableDecision({
			chain: initialChain,
			targetBlockHash: b0.blockHash,
			decision: "scheduled",
			tjNote: "Tonight 8pm Nightly Roundtable session",
			timestamp: "2026-11-25T19:00:00.000Z",
		});

		expect(verifyReverieChain(nightlyScheduled.updatedChain)).toEqual({ valid: true });
		expect(nightlyScheduled.callbackPacket.cadence).toBe("nightly");
		expect(nightlyScheduled.callbackPacket.resumeCommand).toBe(`pi --resume ${SAMPLE_ORIGIN.sessionId}`);
		expect(nightlyScheduled.callbackPacket.lensInspectionUrl).toBe(
			`http://localhost:4318/ui/traces/${SAMPLE_ORIGIN.lensTraceId}`,
		);

		const workSeed = buildRoundtableKanbanSeed(b0, { tag: "work", cadence: "end_of_day" });
		expect(workSeed).toMatchObject({
			id: `kanban-rev-0-${b0.blockHash.slice(0, 8)}`,
			title: "ClickHouse trace rollup index",
			domain: "work",
			tags: ["work", "reverie-flywheel", "whiteboard_coaching"],
			cadence: "end_of_day",
			sourceBlockHash: b0.blockHash,
			originSessionId: SAMPLE_ORIGIN.sessionId,
		});

		const lifeSeed = buildRoundtableKanbanSeed(b1, { tag: "life", cadence: "weekend_deep_dive" });
		expect(lifeSeed).toMatchObject({
			domain: "weekend_lab",
			tags: ["life", "reverie-flywheel", "experiment"],
			cadence: "weekend_deep_dive",
			sourceBlockHash: b1.blockHash,
			originSessionId: "sess-hermes-splinter-77",
		});

		const promoted = recordRoundtableDecision({
			chain: nightlyScheduled.updatedChain,
			targetBlockHash: b1.blockHash,
			decision: "promoted_to_kanban",
			cadence: "end_of_day",
			targetDomain: "work",
			tjNote: "High-leverage governance upgrade -> seed straight into tomorrow morning's work Kanban",
			timestamp: "2026-11-25T19:05:00.000Z",
		});
		expect(verifyReverieChain(promoted.updatedChain)).toEqual({ valid: true });
		expect(promoted.promotedKanbanTask?.domain).toBe("work");
		expect(promoteReverieToKanbanTask(b0).domain).toBe("work");
	});

	it("rejects unsafe sessionId or lensTraceId values to prevent command or URL injection", () => {
		expect(() =>
			mintReverieBlock({
				proofOfWork: CLEAN_POW,
				origin: { ...SAMPLE_ORIGIN, sessionId: "bad; rm -rf /" },
				payload: { kind: "stray_thought", pitch: "Injection attempt" },
			}),
		).toThrow(/Invalid sessionId/);

		expect(() =>
			buildSessionCallbackPacket(
				{
					blockHeight: 0,
					prevHash: GENESIS_PREV_HASH,
					blockHash: "a".repeat(64),
					timestamp: "2026-11-25T09:00:00.000Z",
					proofOfWork: CLEAN_POW,
					origin: { ...SAMPLE_ORIGIN, lensTraceId: "../admin" },
					payload: { kind: "stray_thought", pitch: "Path traversal", status: "pitched" },
				},
				"scheduled",
			),
		).toThrow(/Invalid lensTraceId/);
	});

	it("generates parameterized Neo4j Cypher statements for ReverieBlock, AgentSession, and CleanCommit", () => {
		const block = mintReverieBlock({
			proofOfWork: CLEAN_POW,
			origin: SAMPLE_ORIGIN,
			timestamp: "2026-11-25T10:00:00.000Z",
			payload: {
				kind: "experiment",
				domain: "system2",
				pitch: "Benchmark local Qwen pruning latency.",
			},
		});

		const statements = buildReverieNeo4jStatements([block]);
		expect(statements).toHaveLength(1);
		const stmt = statements[0];
		expect(stmt.statement).toContain("MERGE (b:ReverieBlock {blockHash: $blockHash})");
		expect(stmt.statement).toContain("MERGE (s:AgentSession {sessionId: $sessionId})");
		expect(stmt.statement).toContain("MERGE (c:CleanCommit {commitSha: $commitSha})");
		expect(stmt.statement).toContain("MERGE (b)-[:EARNED_BY]->(c)");
		expect(stmt.statement).toContain("MERGE (b)-[:ORIGINATED_IN]->(s)");
		expect(stmt.parameters).toMatchObject({
			blockHash: block.blockHash,
			sessionId: SAMPLE_ORIGIN.sessionId,
			commitSha: CLEAN_POW.commitSha,
			lensTraceId: SAMPLE_ORIGIN.lensTraceId,
		});
	});
});

describe("Break-Glass AES-256-GCM Encrypted Tool-Call Audit Payload & Chain", () => {
	const SOVEREIGN_KEY = "tj-break-glass-master-secret-2026-system2-labs";

	it("seals sensitive Heretic tool calls with AES-256-GCM, hash-chains publicly without the key, and decrypts only with the sovereign key", () => {
		const envelope = sealBreakGlassAuditPayload(
			{
				toolName: "bash",
				persona: "Heretic",
				sessionId: "sess-heretic-redteam-01",
				payload: {
					shellCommand: "node -e 'process.stdout.write(\"probe-1\")'",
					stdout: "probe-1",
					stderr: "",
				},
			},
			SOVEREIGN_KEY,
		);

		expect(envelope.algorithm).toBe("aes-256-gcm");
		expect(envelope.ivHex).toMatch(/^[0-9a-f]{24}$/);
		expect(envelope.authTagHex).toMatch(/^[0-9a-f]{32}$/);
		expect(envelope.plaintextSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(envelope.ciphertextHex).not.toContain("probe-1");
		expect(envelope.toolName).toBe("bash");
		expect(envelope.persona).toBe("Heretic");
		expect(envelope.sessionId).toBe("sess-heretic-redteam-01");

		const decrypted = decryptBreakGlassAuditPayload<{ shellCommand: string; stdout: string }>(
			envelope,
			SOVEREIGN_KEY,
		);
		expect(decrypted.shellCommand).toContain("probe-1");
		expect(decrypted.stdout).toBe("probe-1");

		const b0 = mintForensicAuditBlock({
			sessionId: envelope.sessionId,
			persona: envelope.persona,
			engine: "pi-system2",
			toolName: envelope.toolName,
			arbiterDecision: "allow",
			riskTier: "high",
			encryptedEnvelope: envelope,
		});
		const b1 = mintForensicAuditBlock({
			prevBlock: b0,
			sessionId: "sess-heretic-redteam-01",
			persona: "Heretic",
			engine: "pi-system2",
			toolName: "bash",
			arbiterDecision: "block",
			riskTier: "critical",
			breakGlassKey: SOVEREIGN_KEY,
			sensitivePayload: {
				shellCommand: "curl http://169.254.169.254/latest/meta-data/",
				stderr: "LeanGuardDeny: metadata SSRF blocked",
			},
		});

		const chain: ForensicAuditBlock[] = [b0, b1];
		expect(verifyForensicAuditChain(chain)).toEqual({ valid: true });
		expect(decryptForensicPayload(b1.encryptedEnvelope, SOVEREIGN_KEY).shellCommand).toContain("169.254.169.254");
	});

	it("rejects decryption when 1 byte of ciphertext or authTag is tampered or when a wrong key is supplied", () => {
		const env = encryptForensicPayload(
			{
				toolName: "bash",
				persona: "Heretic",
				sessionId: "sess-heretic-02",
				payload: { shellCommand: "cat /etc/hosts", stdout: "127.0.0.1 localhost" },
			},
			SOVEREIGN_KEY,
		);

		expect(() => decryptBreakGlassAuditPayload(env, "wrong-secret-key")).toThrow();

		const tamperedCiphertext = {
			...env,
			ciphertextHex: `${env.ciphertextHex.slice(0, -2)}${env.ciphertextHex.endsWith("00") ? "ff" : "00"}`,
		};
		expect(() => decryptBreakGlassAuditPayload(tamperedCiphertext, SOVEREIGN_KEY)).toThrow();

		const tamperedAuthTag = {
			...env,
			authTagHex: `${env.authTagHex.slice(0, -2)}${env.authTagHex.endsWith("00") ? "ff" : "00"}`,
		};
		expect(() => decryptBreakGlassAuditPayload(tamperedAuthTag, SOVEREIGN_KEY)).toThrow();
	});
});

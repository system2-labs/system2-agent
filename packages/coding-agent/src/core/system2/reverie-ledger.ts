/**
 * Immortalized Hash-Chained Dream/Reverie Ledger ("The Reverie Chain") &
 * Break-Glass AES-256-GCM Encrypted Tool-Call Audit Ledger.
 * Enforces Plane 1 -> Plane 2 Proof-of-Verification, SHA-256 hash chaining,
 * Nightly/EOD Roundtable callbacks, Positive Data Flywheel Kanban seed builder,
 * Neo4j Cypher export, and break-glass encrypted forensic auditing.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const GENESIS_PREV_HASH = "0".repeat(64);
export const DEFAULT_LENS_BASE_URL = "http://localhost:4318/ui/traces";

export type ReverieKind = "stray_thought" | "whiteboard_coaching" | "experiment" | "open_forum";
export type ReverieEngine = "pi-system2" | "agy" | "hermes" | "claude";
export type ReverieStatus =
	| "pitched"
	| "scheduled"
	| "deferred_next_weekend"
	| "explored"
	| "scheduled_tonight"
	| "promoted_to_kanban"
	| "deferred_next_eod";
export type RoundtableDecisionKind =
	| "scheduled"
	| "deferred_next_weekend"
	| "scheduled_tonight"
	| "promoted_to_kanban"
	| "deferred_next_eod";
export type RoundtableCadence =
	| "nightly"
	| "end_of_day"
	| "friday_night"
	| "weekend_deep_dive"
	| "nightly_eod"
	| "friday_weekly";
export type KanbanTargetDomain = "work" | "side_projects" | "hobbies_life" | "weekend_lab";
export type ForensicArbiterDecision = "allow" | "block";
export type ForensicRiskTier = "low" | "medium" | "high" | "critical";

export interface ReverieProofOfWork {
	ticketSlug: string;
	commitSha: string;
	verifyPassedRound: number;
	docsUpdated: boolean;
	specPath?: string;
}

export interface ReverieOrigin {
	engine: ReverieEngine;
	persona: string;
	sessionId: string;
	transcriptPath?: string;
	lensTraceId?: string;
}

export interface ReveriePayload {
	kind: ReverieKind;
	domain?: string;
	title?: string;
	pitch: string;
	status: ReverieStatus;
	tags?: readonly string[];
	targetBlockHash?: string;
	tjNote?: string;
}

export interface ReverieBlock {
	blockHeight: number;
	prevHash: string;
	blockHash: string;
	timestamp: string;
	proofOfWork: ReverieProofOfWork;
	origin: ReverieOrigin;
	payload: ReveriePayload;
}

export interface MintReverieBlockInput {
	proofOfWork: ReverieProofOfWork;
	origin: ReverieOrigin;
	payload: Omit<ReveriePayload, "status"> & { status?: ReverieStatus };
	timestamp?: string;
	prevBlock?: ReverieBlock;
	blockHeight?: number;
	prevHash?: string;
}

export interface ReverieChainVerification {
	valid: boolean;
	tamperedBlockHeight?: number;
	reason?: string;
}

export interface RoundtableFilter {
	status?: ReverieStatus;
	kind?: ReverieKind;
	domain?: string;
	persona?: string;
	engine?: ReverieEngine;
}

export interface RoundtableKanbanSeed {
	id: string;
	title: string;
	domain: KanbanTargetDomain;
	tags: string[];
	cadence: RoundtableCadence;
	sourceBlockHash: string;
	originSessionId: string;
	sourceReverieBlockHash: string;
	sourceSessionId: string;
	lensTraceId?: string;
}

export type PromotedKanbanSeedTask = RoundtableKanbanSeed;

export interface SessionCallbackPacket {
	targetBlockHash: string;
	decision: RoundtableDecisionKind;
	cadence: RoundtableCadence;
	sessionId: string;
	engine: ReverieEngine;
	resumeCommand: string;
	lensInspectionUrl?: string;
	messageToAgent: string;
	tjNote?: string;
	promotedKanbanTask?: RoundtableKanbanSeed;
}

export interface RecordRoundtableDecisionInput {
	chain: readonly ReverieBlock[];
	targetBlockHash: string;
	decision: RoundtableDecisionKind;
	cadence?: RoundtableCadence;
	targetDomain?: KanbanTargetDomain;
	tjNote?: string;
	proofOfWork?: ReverieProofOfWork;
	timestamp?: string;
}

export interface RoundtableDecisionResult {
	decisionBlock: ReverieBlock;
	updatedChain: ReverieBlock[];
	callbackPacket: SessionCallbackPacket;
	promotedKanbanTask?: RoundtableKanbanSeed;
}

export interface ReverieCypherStatement {
	statement: string;
	parameters: Record<string, unknown>;
}

export interface ForensicSensitivePayload {
	toolArgs?: Record<string, unknown> | string;
	shellCommand?: string;
	stdout?: string;
	stderr?: string;
	fileDiff?: string;
	notes?: string;
	[key: string]: unknown;
}

export interface EncryptedAuditEnvelope {
	algorithm: "aes-256-gcm";
	ivHex: string;
	authTagHex: string;
	ciphertextHex: string;
	plaintextSha256: string;
	toolName: string;
	persona: string;
	sessionId: string;
}

export type ForensicEncryptedEnvelope = EncryptedAuditEnvelope;

export interface SealBreakGlassAuditInput {
	payload?: unknown;
	toolName?: string;
	persona?: string;
	sessionId?: string;
	key?: string | Buffer | Uint8Array;
	ivHex?: string;
	[key: string]: unknown;
}

export interface ForensicAuditBlock {
	blockHeight: number;
	prevHash: string;
	blockHash: string;
	timestamp: string;
	sessionId: string;
	persona: string;
	engine: ReverieEngine;
	toolName: string;
	arbiterDecision: ForensicArbiterDecision;
	riskTier: ForensicRiskTier;
	encryptedEnvelope: EncryptedAuditEnvelope;
}

export interface MintForensicAuditBlockInput {
	sessionId: string;
	persona: string;
	engine: ReverieEngine;
	toolName: string;
	arbiterDecision: ForensicArbiterDecision;
	riskTier: ForensicRiskTier;
	sensitivePayload?: ForensicSensitivePayload;
	breakGlassKey?: string | Buffer | Uint8Array;
	ivHex?: string;
	encryptedEnvelope?: EncryptedAuditEnvelope;
	timestamp?: string;
	prevBlock?: ForensicAuditBlock;
	blockHeight?: number;
	prevHash?: string;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const HEX_SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;
const VALID_DOMAINS = new Set<KanbanTargetDomain>(["work", "side_projects", "hobbies_life", "weekend_lab"]);

function sanitizeIdentifier(value: string, fieldName: string): string {
	if (typeof value !== "string" || value.length === 0 || !SAFE_ID_PATTERN.test(value) || value.includes("..")) {
		throw new Error(`Invalid ${fieldName}: must match [A-Za-z0-9._:-]+ without path traversal`);
	}
	return value;
}

function canonicalizeJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((k) => record[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(record[k])}`).join(",")}}`;
}

export function validateProofOfWork(proofOfWork: ReverieProofOfWork): true {
	if (!proofOfWork || typeof proofOfWork.ticketSlug !== "string" || proofOfWork.ticketSlug.trim().length === 0) {
		throw new Error("Plane 1/2 gate denied: ticketSlug must be a non-empty string");
	}
	if (typeof proofOfWork.commitSha !== "string" || !HEX_SHA_PATTERN.test(proofOfWork.commitSha)) {
		throw new Error("Plane 1/2 gate denied: commitSha must be a valid 7-64 character hex SHA");
	}
	if (proofOfWork.verifyPassedRound !== 1) {
		throw new Error(
			`Plane 1/2 gate denied: verifyPassedRound must be 1 for clean first-pass verification (got ${String(proofOfWork.verifyPassedRound)})`,
		);
	}
	if (proofOfWork.docsUpdated !== true) {
		throw new Error("Plane 1/2 gate denied: docsUpdated must be true before minting a Reverie block");
	}
	return true;
}

export function computeReverieBlockHash(block: Omit<ReverieBlock, "blockHash">): string {
	const canonical = canonicalizeJson({
		blockHeight: block.blockHeight,
		prevHash: block.prevHash,
		timestamp: block.timestamp,
		proofOfWork: block.proofOfWork,
		origin: block.origin,
		payload: block.payload,
	});
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function mintReverieBlock(input: MintReverieBlockInput, prevBlockArg?: ReverieBlock): ReverieBlock {
	validateProofOfWork(input.proofOfWork);
	sanitizeIdentifier(input.origin.sessionId, "sessionId");
	if (input.origin.lensTraceId !== undefined) sanitizeIdentifier(input.origin.lensTraceId, "lensTraceId");
	if (typeof input.origin.persona !== "string" || input.origin.persona.trim().length === 0) {
		throw new Error("Reverie origin.persona must be a non-empty string");
	}
	if (typeof input.payload.pitch !== "string" || input.payload.pitch.trim().length === 0) {
		throw new Error("Reverie payload.pitch must be a non-empty string");
	}
	const prev = prevBlockArg ?? input.prevBlock;
	const draft: Omit<ReverieBlock, "blockHash"> = {
		blockHeight: prev ? prev.blockHeight + 1 : (input.blockHeight ?? 0),
		prevHash: prev ? prev.blockHash : (input.prevHash ?? GENESIS_PREV_HASH),
		timestamp: input.timestamp ?? new Date().toISOString(),
		proofOfWork: input.proofOfWork,
		origin: input.origin,
		payload: { ...input.payload, status: input.payload.status ?? "pitched" },
	};
	return { ...draft, blockHash: computeReverieBlockHash(draft) };
}

export function verifyReverieChain(blocks: readonly ReverieBlock[]): ReverieChainVerification {
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.blockHeight !== i) {
			return {
				valid: false,
				tamperedBlockHeight: i,
				reason: `Non-contiguous blockHeight at index ${i}: expected ${i}, got ${String(block.blockHeight)}`,
			};
		}
		const expectedPrevHash = i === 0 ? GENESIS_PREV_HASH : blocks[i - 1].blockHash;
		if (block.prevHash !== expectedPrevHash) {
			return {
				valid: false,
				tamperedBlockHeight: i,
				reason: i === 0 ? "Genesis block prevHash mismatch" : `Broken prevHash link at blockHeight ${i}`,
			};
		}
		try {
			validateProofOfWork(block.proofOfWork);
		} catch (err) {
			return {
				valid: false,
				tamperedBlockHeight: i,
				reason: err instanceof Error ? err.message : "Invalid proofOfWork",
			};
		}
		const recomputed = computeReverieBlockHash(block);
		if (block.blockHash !== recomputed) {
			return {
				valid: false,
				tamperedBlockHeight: i,
				reason: `SHA-256 blockHash mismatch at blockHeight ${i}: expected ${recomputed}, got ${block.blockHash}`,
			};
		}
	}
	return { valid: true };
}

export function readReverieChainFromFile(filePath: string): ReverieBlock[] {
	if (!existsSync(filePath)) return [];
	return readFileSync(filePath, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as ReverieBlock);
}

export function appendReverieBlockToFile(filePath: string, block: ReverieBlock): void {
	const existing = readReverieChainFromFile(filePath);
	const check = verifyReverieChain([...existing, block]);
	if (!check.valid) {
		throw new Error(
			`Cannot append invalid Reverie block at height ${String(check.tamperedBlockHeight)}: ${check.reason}`,
		);
	}
	mkdirSync(path.dirname(filePath), { recursive: true });
	let prefix = "";
	if (existsSync(filePath)) {
		const current = readFileSync(filePath, "utf8");
		if (current.length > 0 && !current.endsWith("\n")) prefix = "\n";
	}
	appendFileSync(filePath, `${prefix}${JSON.stringify(block)}\n`, "utf8");
}

export function queryRoundtablePitches(blocks: readonly ReverieBlock[], filter: RoundtableFilter = {}): ReverieBlock[] {
	const statusUpdates = new Map<string, { status: ReverieStatus; tjNote?: string }>();
	for (const block of blocks) {
		if (block.payload.targetBlockHash) {
			statusUpdates.set(block.payload.targetBlockHash, {
				status: block.payload.status,
				tjNote: block.payload.tjNote,
			});
		}
	}
	const pitches: ReverieBlock[] = [];
	for (const block of blocks) {
		if (block.payload.targetBlockHash) continue;
		const override = statusUpdates.get(block.blockHash);
		const resolved: ReverieBlock = override
			? {
					...block,
					payload: {
						...block.payload,
						status: override.status,
						...(override.tjNote !== undefined ? { tjNote: override.tjNote } : {}),
					},
				}
			: block;
		if (filter.status && resolved.payload.status !== filter.status) continue;
		if (filter.kind && resolved.payload.kind !== filter.kind) continue;
		if (filter.domain && resolved.payload.domain !== filter.domain) continue;
		if (filter.persona && resolved.origin.persona !== filter.persona) continue;
		if (filter.engine && resolved.origin.engine !== filter.engine) continue;
		pitches.push(resolved);
	}
	return pitches;
}

/**
 * Turns an approved/scheduled Reverie pitch directly into a top-of-funnel
 * Kanban seed (`LifeTaskInput` compatible) to close the Positive Data Flywheel.
 */
export function buildRoundtableKanbanSeed(
	block: ReverieBlock,
	options: { tag?: "work" | "life"; cadence?: RoundtableCadence; targetDomain?: KanbanTargetDomain } = {},
): RoundtableKanbanSeed {
	const safeSessionId = sanitizeIdentifier(block.origin.sessionId, "sessionId");
	const safeTraceId =
		block.origin.lensTraceId !== undefined ? sanitizeIdentifier(block.origin.lensTraceId, "lensTraceId") : undefined;
	const tag: "work" | "life" =
		options.tag ??
		(options.targetDomain === "work" ||
		block.payload.domain === "work" ||
		block.payload.kind === "whiteboard_coaching"
			? "work"
			: "life");
	const domain: KanbanTargetDomain =
		options.targetDomain ??
		(options.tag
			? options.tag === "work"
				? "work"
				: "weekend_lab"
			: block.payload.domain && VALID_DOMAINS.has(block.payload.domain as KanbanTargetDomain)
				? (block.payload.domain as KanbanTargetDomain)
				: tag === "work"
					? "work"
					: "weekend_lab");
	return {
		id: `kanban-rev-${block.blockHeight}-${block.blockHash.slice(0, 8)}`,
		title: block.payload.title ?? block.payload.pitch,
		domain,
		tags: [tag, "reverie-flywheel", block.payload.kind],
		cadence: options.cadence ?? "nightly",
		sourceBlockHash: block.blockHash,
		originSessionId: safeSessionId,
		sourceReverieBlockHash: block.blockHash,
		sourceSessionId: safeSessionId,
		...(safeTraceId ? { lensTraceId: safeTraceId } : {}),
	};
}

export function promoteReverieToKanbanTask(
	block: ReverieBlock,
	targetDomain?: KanbanTargetDomain,
): RoundtableKanbanSeed {
	return buildRoundtableKanbanSeed(block, { targetDomain });
}

export function buildSessionCallbackPacket(
	targetBlock: ReverieBlock,
	decision: RoundtableDecisionKind,
	tjNote?: string,
	cadence: RoundtableCadence = "nightly",
	targetDomain?: KanbanTargetDomain,
): SessionCallbackPacket {
	const safeSessionId = sanitizeIdentifier(targetBlock.origin.sessionId, "sessionId");
	const safeTraceId =
		targetBlock.origin.lensTraceId !== undefined
			? sanitizeIdentifier(targetBlock.origin.lensTraceId, "lensTraceId")
			: undefined;
	const resumeByEngine: Record<ReverieEngine, string> = {
		"pi-system2": `pi --resume ${safeSessionId}`,
		agy: `agy chat --resume ${safeSessionId}`,
		hermes: `hermes session resume ${safeSessionId}`,
		claude: `claude --resume ${safeSessionId}`,
	};
	const slotDescriptions: Record<RoundtableDecisionKind, string> = {
		scheduled: "scheduled for this weekend's Friday Night Roundtable",
		deferred_next_weekend: "deferred_next_weekend (slotted for next weekend's roundtable)",
		scheduled_tonight: "scheduled_tonight for tonight's Nightly EOD Roundtable",
		promoted_to_kanban: "promoted_to_kanban (seeded into the top-of-funnel Work/Life Kanban graph)",
		deferred_next_eod: "deferred_next_eod (slotted for tomorrow evening's EOD roundtable)",
	};
	const promotedKanbanTask =
		decision === "promoted_to_kanban" ? buildRoundtableKanbanSeed(targetBlock, { cadence, targetDomain }) : undefined;
	const noteSuffix = tjNote ? ` TJ note: "${tjNote}"` : "";
	return {
		targetBlockHash: targetBlock.blockHash,
		decision,
		cadence,
		sessionId: safeSessionId,
		engine: targetBlock.origin.engine,
		resumeCommand: resumeByEngine[targetBlock.origin.engine],
		...(safeTraceId ? { lensInspectionUrl: `${DEFAULT_LENS_BASE_URL}/${safeTraceId}` } : {}),
		messageToAgent: `[Reverie Roundtable (${cadence})] Pitch "${targetBlock.payload.title ?? targetBlock.payload.pitch}" (${targetBlock.blockHash.slice(0, 12)}) is ${slotDescriptions[decision]}.${noteSuffix}`,
		...(tjNote !== undefined ? { tjNote } : {}),
		...(promotedKanbanTask ? { promotedKanbanTask } : {}),
	};
}

export function recordRoundtableDecision(input: RecordRoundtableDecisionInput): RoundtableDecisionResult {
	if (input.chain.length === 0) {
		throw new Error("Cannot record roundtable decision on an empty Reverie chain");
	}
	const targetBlock = input.chain.find((b) => b.blockHash === input.targetBlockHash);
	if (!targetBlock) {
		throw new Error(`Target Reverie block not found in chain: ${input.targetBlockHash}`);
	}
	const lastBlock = input.chain[input.chain.length - 1];
	const decisionBlock = mintReverieBlock({
		prevBlock: lastBlock,
		timestamp: input.timestamp,
		proofOfWork: input.proofOfWork ?? targetBlock.proofOfWork,
		origin: targetBlock.origin,
		payload: {
			kind: targetBlock.payload.kind,
			domain: targetBlock.payload.domain,
			title: targetBlock.payload.title,
			pitch: `Roundtable decision (${input.decision}) for ${targetBlock.blockHash}`,
			status: input.decision,
			targetBlockHash: targetBlock.blockHash,
			tjNote: input.tjNote,
		},
	});
	const callbackPacket = buildSessionCallbackPacket(
		targetBlock,
		input.decision,
		input.tjNote,
		input.cadence ?? "nightly",
		input.targetDomain,
	);
	return {
		decisionBlock,
		updatedChain: [...input.chain, decisionBlock],
		callbackPacket,
		...(callbackPacket.promotedKanbanTask ? { promotedKanbanTask: callbackPacket.promotedKanbanTask } : {}),
	};
}

export function buildReverieNeo4jStatements(
	blockOrBlocks: ReverieBlock | readonly ReverieBlock[],
): ReverieCypherStatement[] {
	const blocks = Array.isArray(blockOrBlocks) ? blockOrBlocks : [blockOrBlocks];
	return blocks.map((block) => ({
		statement: [
			"MERGE (b:ReverieBlock {blockHash: $blockHash})",
			"SET b.blockHeight = $blockHeight, b.prevHash = $prevHash, b.timestamp = $timestamp, b.kind = $kind, b.status = $status, b.domain = $domain, b.pitch = $pitch, b.targetBlockHash = $targetBlockHash, b.tjNote = $tjNote",
			"MERGE (s:AgentSession {sessionId: $sessionId})",
			"SET s.engine = $engine, s.persona = $persona, s.lensTraceId = $lensTraceId",
			"MERGE (c:CleanCommit {commitSha: $commitSha})",
			"SET c.ticketSlug = $ticketSlug, c.verifyPassedRound = $verifyPassedRound",
			"MERGE (b)-[:EARNED_BY]->(c)",
			"MERGE (b)-[:ORIGINATED_IN]->(s)",
		].join(" "),
		parameters: {
			blockHash: block.blockHash,
			blockHeight: block.blockHeight,
			prevHash: block.prevHash,
			timestamp: block.timestamp,
			kind: block.payload.kind,
			status: block.payload.status,
			domain: block.payload.domain ?? null,
			pitch: block.payload.pitch,
			targetBlockHash: block.payload.targetBlockHash ?? null,
			tjNote: block.payload.tjNote ?? null,
			sessionId: block.origin.sessionId,
			engine: block.origin.engine,
			persona: block.origin.persona,
			lensTraceId: block.origin.lensTraceId ?? null,
			commitSha: block.proofOfWork.commitSha,
			ticketSlug: block.proofOfWork.ticketSlug,
			verifyPassedRound: block.proofOfWork.verifyPassedRound,
		},
	}));
}

function deriveBreakGlassKey(key: string | Buffer | Uint8Array): Buffer {
	if (typeof key === "string") {
		if (key.length === 0) throw new Error("Break-glass encryption key must not be empty");
		if (/^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, "hex");
		return createHash("sha256").update(key, "utf8").digest();
	}
	if (key.byteLength === 0) throw new Error("Break-glass encryption key must not be empty");
	if (key.byteLength === 32) return Buffer.from(key);
	return createHash("sha256").update(key).digest();
}

/**
 * Seals a sensitive tool-call audit payload with Node `node:crypto` AES-256-GCM
 * (random 12-byte IV, 16-byte authTag, and 32-byte key / SHA-256 derived key)
 * into a public hash-chainable `EncryptedAuditEnvelope`.
 */
export function sealBreakGlassAuditPayload(
	input: SealBreakGlassAuditInput,
	keyArg?: string | Buffer | Uint8Array,
	metaArg?: { toolName?: string; persona?: string; sessionId?: string; ivHex?: string },
): EncryptedAuditEnvelope {
	const rawKey = keyArg ?? input.key;
	if (rawKey === undefined) throw new Error("Break-glass encryption key is required");
	const aesKey = deriveBreakGlassKey(rawKey);
	const ivHex = metaArg?.ivHex ?? (typeof input.ivHex === "string" ? input.ivHex : undefined);
	const iv = ivHex ? Buffer.from(ivHex, "hex") : randomBytes(12);
	if (iv.byteLength !== 12) throw new Error("AES-256-GCM IV must be 12 bytes (24 hex chars)");

	const toolName = metaArg?.toolName ?? (typeof input.toolName === "string" ? input.toolName : "tool_call");
	const persona = metaArg?.persona ?? (typeof input.persona === "string" ? input.persona : "Heretic");
	const sessionId = sanitizeIdentifier(
		metaArg?.sessionId ?? (typeof input.sessionId === "string" ? input.sessionId : "sess-break-glass"),
		"sessionId",
	);
	const targetPayload = "payload" in input && input.payload !== undefined ? input.payload : input;
	const plaintext = canonicalizeJson(targetPayload);
	const plaintextSha256 = createHash("sha256").update(plaintext, "utf8").digest("hex");
	const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return {
		algorithm: "aes-256-gcm",
		ivHex: iv.toString("hex"),
		authTagHex: authTag.toString("hex"),
		ciphertextHex: ciphertext.toString("hex"),
		plaintextSha256,
		toolName,
		persona,
		sessionId,
	};
}

/**
 * Decrypts an `EncryptedAuditEnvelope` using the sovereign break-glass key,
 * verifying both the 16-byte GCM authTag and plaintext SHA-256 digest.
 */
export function decryptBreakGlassAuditPayload<T = ForensicSensitivePayload>(
	envelope: Pick<EncryptedAuditEnvelope, "ivHex" | "authTagHex" | "ciphertextHex" | "plaintextSha256">,
	key: string | Buffer | Uint8Array,
): T {
	const aesKey = deriveBreakGlassKey(key);
	const iv = Buffer.from(envelope.ivHex, "hex");
	const authTag = Buffer.from(envelope.authTagHex, "hex");
	if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
		throw new Error("Invalid AES-256-GCM envelope IV or authTag length");
	}
	const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
	decipher.setAuthTag(authTag);
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertextHex, "hex")),
		decipher.final(),
	]).toString("utf8");
	const actualSha = createHash("sha256").update(plaintext, "utf8").digest("hex");
	if (actualSha !== envelope.plaintextSha256) {
		throw new Error("Break-glass payload plaintextSha256 integrity mismatch");
	}
	return JSON.parse(plaintext) as T;
}

export const encryptForensicPayload = sealBreakGlassAuditPayload;
export const decryptForensicPayload = decryptBreakGlassAuditPayload;

export function computeForensicBlockHash(block: Omit<ForensicAuditBlock, "blockHash">): string {
	return createHash("sha256")
		.update(
			canonicalizeJson({
				blockHeight: block.blockHeight,
				prevHash: block.prevHash,
				timestamp: block.timestamp,
				sessionId: block.sessionId,
				persona: block.persona,
				engine: block.engine,
				toolName: block.toolName,
				arbiterDecision: block.arbiterDecision,
				riskTier: block.riskTier,
				encryptedEnvelope: block.encryptedEnvelope,
			}),
			"utf8",
		)
		.digest("hex");
}

export function mintForensicAuditBlock(
	input: MintForensicAuditBlockInput,
	prevBlockArg?: ForensicAuditBlock,
): ForensicAuditBlock {
	sanitizeIdentifier(input.sessionId, "sessionId");
	const envelope =
		input.encryptedEnvelope ??
		(input.sensitivePayload && input.breakGlassKey !== undefined
			? sealBreakGlassAuditPayload(
					{
						payload: input.sensitivePayload,
						toolName: input.toolName,
						persona: input.persona,
						sessionId: input.sessionId,
						ivHex: input.ivHex,
					},
					input.breakGlassKey,
				)
			: undefined);
	if (!envelope) {
		throw new Error("mintForensicAuditBlock requires either encryptedEnvelope or sensitivePayload + breakGlassKey");
	}
	const prev = prevBlockArg ?? input.prevBlock;
	const draft: Omit<ForensicAuditBlock, "blockHash"> = {
		blockHeight: prev ? prev.blockHeight + 1 : (input.blockHeight ?? 0),
		prevHash: prev ? prev.blockHash : (input.prevHash ?? GENESIS_PREV_HASH),
		timestamp: input.timestamp ?? new Date().toISOString(),
		sessionId: input.sessionId,
		persona: input.persona,
		engine: input.engine,
		toolName: input.toolName,
		arbiterDecision: input.arbiterDecision,
		riskTier: input.riskTier,
		encryptedEnvelope: envelope,
	};
	return { ...draft, blockHash: computeForensicBlockHash(draft) };
}

export function verifyForensicAuditChain(blocks: readonly ForensicAuditBlock[]): ReverieChainVerification {
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.blockHeight !== i) {
			return { valid: false, tamperedBlockHeight: i, reason: `Non-contiguous forensic blockHeight at index ${i}` };
		}
		const expectedPrev = i === 0 ? GENESIS_PREV_HASH : blocks[i - 1].blockHash;
		if (block.prevHash !== expectedPrev) {
			return { valid: false, tamperedBlockHeight: i, reason: `Broken forensic prevHash link at blockHeight ${i}` };
		}
		const env = block.encryptedEnvelope;
		if (
			!env ||
			env.algorithm !== "aes-256-gcm" ||
			!/^[0-9a-fA-F]{24}$/.test(env.ivHex) ||
			!/^[0-9a-fA-F]{32}$/.test(env.authTagHex) ||
			!/^[0-9a-fA-F]{64}$/.test(env.plaintextSha256) ||
			!/^[0-9a-fA-F]+$/.test(env.ciphertextHex)
		) {
			return { valid: false, tamperedBlockHeight: i, reason: `Malformed encryptedEnvelope at blockHeight ${i}` };
		}
		const recomputed = computeForensicBlockHash(block);
		if (block.blockHash !== recomputed) {
			return {
				valid: false,
				tamperedBlockHeight: i,
				reason: `Forensic blockHash mismatch at blockHeight ${i}: expected ${recomputed}, got ${block.blockHash}`,
			};
		}
	}
	return { valid: true };
}

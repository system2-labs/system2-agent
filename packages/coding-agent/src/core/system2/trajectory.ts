import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MatchedError } from "./sentinel.ts";

export type System2TrajectoryStage = "pre_guard" | "post_guard" | "rollback";

export interface System2ToolCallSnapshot {
	tool: string;
	args: Record<string, unknown>;
}

export interface System2PassingFix {
	tool: string;
	args: Record<string, unknown>;
	summary?: string;
}

/**
 * Structured JSONL record persisted for System 2 guard blocks, rollbacks,
 * and paired rejection-to-fix preference trajectories (DPO/GRPO retraining).
 */
export interface System2TrajectoryRecord {
	timestamp: string;
	session_id: string;
	stage: System2TrajectoryStage;
	context: string;
	rejected_call: System2ToolCallSnapshot;
	guard_reason: string;
	eventual_passing_fix: System2PassingFix | null;
	rollback_latency_ms?: number;
	sentinel_errors?: Array<{ line: number; text: string }>;
}

export interface RecordRejectionInput {
	stage: System2TrajectoryStage;
	context: string;
	rejected_call: System2ToolCallSnapshot;
	guard_reason: string;
	rollback_latency_ms?: number;
	sentinel_errors?: MatchedError[];
}

export interface PendingTrajectoryRejection {
	stage: System2TrajectoryStage;
	context: string;
	rejected_call: System2ToolCallSnapshot;
	guard_reason: string;
	rollback_latency_ms?: number;
	sentinel_errors?: Array<{ line: number; text: string }>;
}

export interface System2TrajectoryLoggerOptions {
	dir?: string;
	sessionId?: string;
	fileName?: string;
}

/**
 * Resolve the trajectories directory, preferring an explicit override, then
 * SYSTEM2_TRAJECTORIES_DIR, and finally ~/.system2/agent/trajectories.
 */
export function resolveTrajectoriesDir(overrideDir?: string): string {
	return overrideDir || process.env.SYSTEM2_TRAJECTORIES_DIR || join(homedir(), ".system2", "agent", "trajectories");
}

function sanitizeFileSegment(segment: string): string {
	const cleaned = segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
	return cleaned || "session";
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate parsed JSONL rows at the disk trust boundary before returning them. */
function isValidTrajectoryRecord(value: unknown): value is System2TrajectoryRecord {
	if (!isRecordObject(value)) return false;
	if (typeof value.timestamp !== "string" || typeof value.session_id !== "string") return false;
	if (value.stage !== "pre_guard" && value.stage !== "post_guard" && value.stage !== "rollback") return false;
	if (typeof value.context !== "string" || typeof value.guard_reason !== "string") return false;
	if (!isRecordObject(value.rejected_call) || typeof value.rejected_call.tool !== "string") return false;
	if (!isRecordObject(value.rejected_call.args)) return false;
	if (value.eventual_passing_fix !== null) {
		if (!isRecordObject(value.eventual_passing_fix) || typeof value.eventual_passing_fix.tool !== "string") {
			return false;
		}
		if (!isRecordObject(value.eventual_passing_fix.args)) return false;
	}
	return true;
}

/**
 * Durable JSONL logger for System 2 guard rejections, rollbacks, and
 * subsequent passing fixes. Every rejection is flushed immediately so
 * unrecovered failures survive crashes; when a later fix passes, a paired
 * preference record with both rejected_call and eventual_passing_fix is emitted.
 */
export class System2TrajectoryLogger {
	private readonly _dir: string;
	private readonly _sessionId: string;
	private readonly _filePath: string;
	private _pendingRejection: PendingTrajectoryRejection | null = null;

	constructor(options: System2TrajectoryLoggerOptions = {}) {
		this._dir = resolveTrajectoriesDir(options.dir);
		this._sessionId = options.sessionId || `session-${Date.now()}`;
		const fileName = options.fileName || `${sanitizeFileSegment(this._sessionId)}.jsonl`;
		this._filePath = join(this._dir, fileName);
	}

	get dir(): string {
		return this._dir;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	get filePath(): string {
		return this._filePath;
	}

	getPendingRejection(): PendingTrajectoryRejection | null {
		return this._pendingRejection;
	}

	hasPendingRejection(): boolean {
		return this._pendingRejection !== null;
	}

	recordRejection(input: RecordRejectionInput): System2TrajectoryRecord {
		const sentinelErrors =
			input.sentinel_errors && input.sentinel_errors.length > 0
				? input.sentinel_errors.map((e) => ({ line: e.line, text: e.text }))
				: undefined;

		this._pendingRejection = {
			stage: input.stage,
			context: input.context,
			rejected_call: { tool: input.rejected_call.tool, args: { ...input.rejected_call.args } },
			guard_reason: input.guard_reason,
			...(input.rollback_latency_ms === undefined ? {} : { rollback_latency_ms: input.rollback_latency_ms }),
			...(sentinelErrors ? { sentinel_errors: sentinelErrors } : {}),
		};

		const record: System2TrajectoryRecord = {
			timestamp: new Date().toISOString(),
			session_id: this._sessionId,
			stage: this._pendingRejection.stage,
			context: this._pendingRejection.context,
			rejected_call: this._pendingRejection.rejected_call,
			guard_reason: this._pendingRejection.guard_reason,
			eventual_passing_fix: null,
			...(this._pendingRejection.rollback_latency_ms === undefined
				? {}
				: { rollback_latency_ms: this._pendingRejection.rollback_latency_ms }),
			...(this._pendingRejection.sentinel_errors ? { sentinel_errors: this._pendingRejection.sentinel_errors } : {}),
		};

		this._appendRecord(record);
		return record;
	}

	recordPassingFix(fix: System2PassingFix, contextOverride?: string): System2TrajectoryRecord | null {
		if (!this._pendingRejection) return null;
		const pending = this._pendingRejection;
		this._pendingRejection = null;

		const record: System2TrajectoryRecord = {
			timestamp: new Date().toISOString(),
			session_id: this._sessionId,
			stage: pending.stage,
			context: contextOverride || pending.context,
			rejected_call: pending.rejected_call,
			guard_reason: pending.guard_reason,
			eventual_passing_fix: {
				tool: fix.tool,
				args: { ...fix.args },
				...(fix.summary === undefined ? {} : { summary: fix.summary }),
			},
			...(pending.rollback_latency_ms === undefined ? {} : { rollback_latency_ms: pending.rollback_latency_ms }),
			...(pending.sentinel_errors ? { sentinel_errors: pending.sentinel_errors } : {}),
		};

		this._appendRecord(record);
		return record;
	}

	private _appendRecord(record: System2TrajectoryRecord): void {
		mkdirSync(this._dir, { recursive: true });
		appendFileSync(this._filePath, `${JSON.stringify(record)}\n`, "utf-8");
	}
}

export function createTrajectoryLogger(options?: System2TrajectoryLoggerOptions): System2TrajectoryLogger {
	return new System2TrajectoryLogger(options);
}

/**
 * Load recent System 2 trajectory records from JSONL files for episodic
 * mistake injection, ordered newest-first up to `limit`.
 */
export function loadRecentMistakes(dir?: string, limit = 10): System2TrajectoryRecord[] {
	const targetDir = resolveTrajectoriesDir(dir);
	if (limit <= 0 || !existsSync(targetDir)) return [];

	const files = readdirSync(targetDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();

	const indexed: Array<{ index: number; record: System2TrajectoryRecord }> = [];
	let order = 0;
	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(join(targetDir, file), "utf-8");
		} catch {
			continue;
		}
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isValidTrajectoryRecord(parsed)) {
					indexed.push({ index: order++, record: parsed });
				}
			} catch {
				// Skip corrupted or partial JSONL lines without breaking episodic loading.
			}
		}
	}

	indexed.sort((a, b) => b.record.timestamp.localeCompare(a.record.timestamp) || b.index - a.index);
	return indexed.slice(0, limit).map((entry) => entry.record);
}

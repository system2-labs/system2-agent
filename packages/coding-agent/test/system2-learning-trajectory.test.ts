import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	getSentinelBuffer,
	ingestLogChunk,
	loadRecentMistakes,
	queryTelemetrySentinel,
	type System2TrajectoryRecord,
} from "../src/core/system2/index.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("System 2 sentinel wiring, structured write-backs, and JSONL trajectories", () => {
	let session: AgentSession;
	let repoDir: string;
	let trajectoriesDir: string;
	let previousTrajectoriesEnv: string | undefined;

	beforeEach(async () => {
		repoDir = mkdtempSync(join(tmpdir(), "s2-learn-repo-"));
		trajectoriesDir = mkdtempSync(join(tmpdir(), "s2-learn-traj-"));
		previousTrajectoriesEnv = process.env.SYSTEM2_TRAJECTORIES_DIR;
		process.env.SYSTEM2_TRAJECTORIES_DIR = trajectoriesDir;
		getSentinelBuffer().clear();

		execSync("git init -b main && git config user.name T && git config user.email t@t.com", { cwd: repoDir });
		writeFileSync(join(repoDir, "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
		execSync("git add calc.ts && git commit -m init", { cwd: repoDir });

		const agent = new Agent({
			getApiKey: () => "k",
			streamFn: (() => {}) as any,
			initialState: {
				model: { id: "s2", name: "S2", provider: "system2", api: "anthropic-messages" } as any,
				systemPrompt: "S2",
				tools: [],
				messages: [{ role: "user", content: "Fix add() in calc.ts", timestamp: Date.now() }],
			},
		});
		const sm = SessionManager.inMemory();
		(sm as any).cwd = repoDir;
		session = new AgentSession({
			agent,
			sessionManager: sm,
			settingsManager: SettingsManager.create(repoDir, repoDir),
			cwd: repoDir,
			modelRuntime: getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), repoDir)),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session?.dispose();
		getSentinelBuffer().clear();
		if (previousTrajectoriesEnv === undefined) {
			delete process.env.SYSTEM2_TRAJECTORIES_DIR;
		} else {
			process.env.SYSTEM2_TRAJECTORIES_DIR = previousTrajectoriesEnv;
		}
		if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
		if (existsSync(trajectoriesDir)) rmSync(trajectoriesDir, { recursive: true, force: true });
	});

	function readJsonlRecords(): System2TrajectoryRecord[] {
		const raw = readFileSync(session.system2TrajectoryLogger.filePath, "utf-8").trim();
		if (!raw) return [];
		return raw.split("\n").map((line) => JSON.parse(line) as System2TrajectoryRecord);
	}

	it("ingests streaming bash logs into sentinel and writes structured [System 2 Rollback] feedback back to agent context", async () => {
		const emit = (session as any)._handleAgentEvent;
		const calcPath = join(repoDir, "calc.ts");

		await emit({
			type: "tool_execution_start",
			toolCallId: "e1",
			toolName: "edit",
			args: { path: calcPath, oldText: "a + b", newText: "a - b" },
		});
		writeFileSync(calcPath, "export const add = (a: number, b: number) => a - b;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "e1",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		await emit({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "vitest --run calc.test.ts" },
		});
		await emit({
			type: "tool_execution_update",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "vitest --run calc.test.ts" },
			partialResult: {
				content: [{ text: "INFO: running calc.test.ts\nERROR: unexpected subtraction result\n" }],
			},
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "bash",
			result: {
				content: [
					{
						text: "INFO: running calc.test.ts\nERROR: unexpected subtraction result\nAssertionError: expected -1 to equal 3",
					},
				],
			},
			isError: true,
		});

		// Sentinel ingested the streaming and final bash output without duplicating lines.
		const sentinelSummary = queryTelemetrySentinel();
		expect(sentinelSummary.errorCount).toBe(2);
		expect(sentinelSummary.matchedErrors[0].text).toContain("ERROR: unexpected subtraction result");
		expect(sentinelSummary.matchedErrors[1].text).toContain("AssertionError: expected -1 to equal 3");

		// Structured [System 2 Rollback] write-back landed in lastSystem2Feedback and agent messages.
		expect(session.lastSystem2Feedback).toBeTruthy();
		expect(session.lastSystem2Feedback).toContain("[System 2 Rollback]");
		expect(session.lastSystem2Feedback).toContain("tool=edit");
		expect(session.lastSystem2Feedback).toContain("latency:");
		expect(session.lastSystem2Feedback).toContain("AssertionError: expected -1 to equal 3");

		const feedbackMsg = session.messages.find((m) => m.role === "custom" && m.customType === "system2-feedback");
		expect(feedbackMsg).toBeDefined();
		expect(feedbackMsg && feedbackMsg.role === "custom" ? feedbackMsg.content : "").toContain("[System 2 Rollback]");

		// Worktree rolled back cleanly.
		expect(readFileSync(calcPath, "utf-8")).toBe("export const add = (a: number, b: number) => a + b;\n");

		// JSONL trajectory recorded the rollback with sentinel errors and user prompt context.
		const records = readJsonlRecords();
		expect(records).toHaveLength(1);
		expect(records[0].stage).toBe("rollback");
		expect(records[0].context).toContain("Fix add() in calc.ts");
		expect(records[0].context).toContain(repoDir);
		expect(records[0].rejected_call.tool).toBe("edit");
		expect(records[0].guard_reason).toContain("Sentinel detected 2 errors");
		expect(records[0].eventual_passing_fix).toBeNull();
		expect(records[0].rollback_latency_ms).toBeGreaterThanOrEqual(0);
		expect(records[0].sentinel_errors?.length).toBe(2);
	});

	it("logs pre-guard block and post-guard rollback to JSONL and pairs pre-guard recovery on subsequent valid write", async () => {
		const emit = (session as any)._handleAgentEvent;
		const badFile = join(repoDir, "broken.ts");

		// 1. Pre-guard syntax block
		await expect(
			emit({
				type: "tool_execution_start",
				toolCallId: "pre1",
				toolName: "write",
				args: { path: badFile, content: "export const x = (;" },
			}),
		).rejects.toThrow(/\[System 2 Guard\] Blocked execution/);

		expect(session.lastSystem2Feedback).toContain("[System 2 Guard]");
		expect(session.lastSystem2Feedback).toContain("tool=write");

		// 2. Subsequent valid write resolves the pre-guard rejection into a paired preference record
		await emit({
			type: "tool_execution_start",
			toolCallId: "fix1",
			toolName: "write",
			args: { path: badFile, content: "export const x = 42;\n" },
		});
		writeFileSync(badFile, "export const x = 42;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "fix1",
			toolName: "write",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		// 3. Post-guard rollback on empty file
		const emptyFile = join(repoDir, "empty.ts");
		await emit({
			type: "tool_execution_start",
			toolCallId: "post1",
			toolName: "write",
			args: { path: emptyFile, content: "export const y = 1;" },
		});
		writeFileSync(emptyFile, "");
		await expect(
			emit({
				type: "tool_execution_end",
				toolCallId: "post1",
				toolName: "write",
				result: { content: [] },
				isError: false,
			}),
		).rejects.toThrow(/Post-execution verification failed/);

		expect(session.lastSystem2Feedback).toContain("[System 2 Rollback]");
		expect(session.lastSystem2Feedback).toContain("empty");

		const records = readJsonlRecords();
		expect(records).toHaveLength(3);
		expect(records[0].stage).toBe("pre_guard");
		expect(records[0].eventual_passing_fix).toBeNull();
		expect(records[1].stage).toBe("pre_guard");
		expect(records[1].rejected_call.tool).toBe("write");
		expect(records[1].eventual_passing_fix).not.toBeNull();
		expect(records[1].eventual_passing_fix?.tool).toBe("write");
		expect(records[1].eventual_passing_fix?.args.path).toBe(badFile);
		expect(records[2].stage).toBe("post_guard");
		expect(records[2].eventual_passing_fix).toBeNull();
	});

	it("pairs rolled-back edit with eventual passing fix after tests pass and reads them back via loadRecentMistakes", async () => {
		const emit = (session as any)._handleAgentEvent;
		const calcPath = join(repoDir, "calc.ts");

		// Buggy edit -> failing bash test -> rollback
		await emit({
			type: "tool_execution_start",
			toolCallId: "e-bad",
			toolName: "edit",
			args: { path: calcPath, newText: "export const add = (a: number, b: number) => a * b;\n" },
		});
		writeFileSync(calcPath, "export const add = (a: number, b: number) => a * b;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "e-bad",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});
		await emit({
			type: "tool_execution_start",
			toolCallId: "b-fail",
			toolName: "bash",
			args: { command: "vitest --run" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "b-fail",
			toolName: "bash",
			result: { content: [{ text: "AssertionError: expected 2 to equal 3" }] },
			isError: true,
		});

		// Recovery edit -> passing bash test
		await emit({
			type: "tool_execution_start",
			toolCallId: "e-good",
			toolName: "edit",
			args: { path: calcPath, newText: "export const add = (a: number, b: number) => a + b;\n" },
		});
		writeFileSync(calcPath, "export const add = (a: number, b: number) => a + b;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "e-good",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});
		await emit({
			type: "tool_execution_start",
			toolCallId: "b-pass",
			toolName: "bash",
			args: { command: "vitest --run" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "b-pass",
			toolName: "bash",
			result: { content: [{ text: "Tests  passed in 12ms" }] },
			isError: false,
		});

		const records = readJsonlRecords();
		expect(records).toHaveLength(2);
		expect(records[0].stage).toBe("rollback");
		expect(records[0].eventual_passing_fix).toBeNull();
		expect(records[1].stage).toBe("rollback");
		expect(records[1].rejected_call.tool).toBe("edit");
		expect(records[1].rejected_call.args.newText).toContain("a * b");
		expect(records[1].eventual_passing_fix).not.toBeNull();
		expect(records[1].eventual_passing_fix?.tool).toBe("edit");
		expect(records[1].eventual_passing_fix?.args.newText).toContain("a + b");

		// Episodic mistake loader reads JSONL records newest-first from the configured dir.
		const recent = loadRecentMistakes(trajectoriesDir, 5);
		expect(recent).toHaveLength(2);
		expect(recent[0].eventual_passing_fix).not.toBeNull();
		expect(recent[0].session_id).toBe(session.sessionId);
	});

	it("isolates per-session sentinel from stale global buffer errors on silent passing bash commands", async () => {
		const emit = (session as any)._handleAgentEvent;
		const calcPath = join(repoDir, "calc.ts");
		const updatedCode = "export const add = (a: number, b: number) => a + b + 0;\n";

		// Seed stale error from an unrelated session into the module-global buffer.
		ingestLogChunk("ERROR: stale error from Session A\n");

		await emit({
			type: "tool_execution_start",
			toolCallId: "e-iso",
			toolName: "edit",
			args: { path: calcPath, newText: updatedCode },
		});
		writeFileSync(calcPath, updatedCode);
		await emit({
			type: "tool_execution_end",
			toolCallId: "e-iso",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		await emit({
			type: "tool_execution_start",
			toolCallId: "b-silent",
			toolName: "bash",
			args: { command: "true" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "b-silent",
			toolName: "bash",
			result: { content: [{ text: "" }] },
			isError: false,
		});

		expect(readFileSync(calcPath, "utf-8")).toBe(updatedCode);
		expect(session.lastSystem2Feedback).toBeNull();
	});

	it("still detects sentinel errors and rolls back after exceeding the 5000-line ring-buffer capacity", async () => {
		const emit = (session as any)._handleAgentEvent;
		const calcPath = join(repoDir, "calc.ts");

		// Fill the session's RollingLogBuffer past its 5000-line cap.
		const filler = Array.from({ length: 5005 }, (_, i) => `INFO: boot line ${i + 1}`).join("\n");
		session.system2Sentinel.ingestLogChunk(filler);
		expect(session.system2Sentinel.getLineCount()).toBe(5000);

		await emit({
			type: "tool_execution_start",
			toolCallId: "e-wrap",
			toolName: "edit",
			args: { path: calcPath, newText: "export const add = (a: number, b: number) => a - b;\n" },
		});
		writeFileSync(calcPath, "export const add = (a: number, b: number) => a - b;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "e-wrap",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		await emit({
			type: "tool_execution_start",
			toolCallId: "b-wrap",
			toolName: "bash",
			args: { command: "node test.js" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "b-wrap",
			toolName: "bash",
			result: { content: [{ text: "TypeError: cannot read properties of undefined" }] },
			isError: false,
		});

		expect(readFileSync(calcPath, "utf-8")).toBe("export const add = (a: number, b: number) => a + b;\n");
		expect(session.lastSystem2Feedback).toContain("[System 2 Rollback]");
		expect(session.lastSystem2Feedback).toContain("TypeError: cannot read properties of undefined");
		const records = readJsonlRecords();
		expect(records).toHaveLength(1);
		expect(records[0].stage).toBe("rollback");
	});

	it("does not roll back on passing test output mentioning benign error keywords or zero-error summaries", async () => {
		const emit = (session as any)._handleAgentEvent;
		const calcPath = join(repoDir, "calc.ts");
		const updatedCode = "export const add = (a: number, b: number) => a + b;\nexport const zero = 0;\n";

		await emit({
			type: "tool_execution_start",
			toolCallId: "e-benign",
			toolName: "edit",
			args: { path: calcPath, newText: updatedCode },
		});
		writeFileSync(calcPath, updatedCode);
		await emit({
			type: "tool_execution_end",
			toolCallId: "e-benign",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		await emit({
			type: "tool_execution_start",
			toolCallId: "b-benign",
			toolName: "bash",
			args: { command: "vitest --run" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "b-benign",
			toolName: "bash",
			result: {
				content: [
					{
						text: "✓ handles syntax error cleanly\nTest Files  1 passed (1)\nTests  5 passed (5)\n0 errors, 0 failed",
					},
				],
			},
			isError: false,
		});

		expect(readFileSync(calcPath, "utf-8")).toBe(updatedCode);
		expect(session.lastSystem2Feedback).toBeNull();
		expect(session.activeSystem2Snapshot).toBeNull();
		expect((session.state as any).deliberation?.status).toBe("pass");
	});
});

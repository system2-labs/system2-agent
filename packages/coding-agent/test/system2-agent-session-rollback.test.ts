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
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("AgentSession System 2 regression interception and rollback", () => {
	let session: AgentSession;
	let dir: string;
	let trajectoriesDir: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "s2-sess-test-"));
		trajectoriesDir = mkdtempSync(join(tmpdir(), "s2-sess-traj-"));
		execSync("git init -b main && git config user.name T && git config user.email t@t.com", { cwd: dir });
		writeFileSync(join(dir, "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
		execSync("git add calc.ts && git commit -m c", { cwd: dir });

		const agent = new Agent({
			getApiKey: () => "k",
			streamFn: (() => {}) as any,
			initialState: {
				model: { id: "s2", name: "S2", provider: "system2", api: "anthropic-messages" } as any,
				systemPrompt: "S2",
				tools: [],
			},
		});
		const sm = SessionManager.inMemory();
		(sm as any).cwd = dir;
		session = new AgentSession({
			agent,
			sessionManager: sm,
			settingsManager: SettingsManager.create(dir, dir),
			cwd: dir,
			modelRuntime: getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), dir)),
			resourceLoader: createTestResourceLoader(),
			system2TrajectoriesDir: trajectoriesDir,
		});
	});

	afterEach(() => {
		session?.dispose();
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		if (existsSync(trajectoriesDir)) rmSync(trajectoriesDir, { recursive: true, force: true });
	});

	it("intercepts test assertion failure, triggers rollback engine, and restores pre-regression state", async () => {
		const emit = (session as any)._handleAgentEvent;
		await emit({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "edit",
			args: { path: join(dir, "calc.ts") },
		});
		expect(session.activeSystem2Snapshot).not.toBeNull();

		writeFileSync(join(dir, "calc.ts"), "export const add = (a: number, b: number) => a - b;\n");
		writeFileSync(join(dir, "err.log"), "fail\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		await emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "test" } });
		await emit({
			type: "tool_execution_end",
			toolCallId: "c2",
			toolName: "bash",
			result: { content: [{ text: "AssertionError: expected -1 to equal 3\nFAILED" }] },
			isError: true,
		});

		expect(session.activeSystem2Snapshot).toBeNull();
		expect(readFileSync(join(dir, "calc.ts"), "utf-8")).toBe("export const add = (a: number, b: number) => a + b;\n");
		expect(existsSync(join(dir, "err.log"))).toBe(false);
		expect(execSync("git status --porcelain", { cwd: dir }).toString().trim()).toBe("");
	});

	it("suppresses naive auto-retry when model provider is system2", async () => {
		const willRetry = (session as any)._willRetryAfterAgentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ text: "err" }], stopReason: "error" }],
		});
		expect(willRetry).toBe(false);
		expect(await (session as any)._prepareRetry({ role: "assistant", content: [], stopReason: "error" })).toBe(false);
		expect(session.retryAttempt).toBe(0);
	});

	it("rolls back and throws when post-execution verification fails on invalid file state", async () => {
		const emit = (session as any)._handleAgentEvent;
		const emptyFile = join(dir, "empty.ts");
		await emit({
			type: "tool_execution_start",
			toolCallId: "c3",
			toolName: "write",
			args: { path: emptyFile, content: "const x = 1;" },
		});
		writeFileSync(emptyFile, "");
		await expect(
			emit({
				type: "tool_execution_end",
				toolCallId: "c3",
				toolName: "write",
				result: { content: [] },
				isError: false,
			}),
		).rejects.toThrow(/Post-execution verification failed/);
		expect(existsSync(emptyFile)).toBe(false);
	});

	it("does not roll back read-only bash output containing FAILED in a non-git directory", async () => {
		// No git init: rollback must never run and files must stay intact.
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		writeFileSync(join(dir, "notes.txt"), "keep me\n");
		const emit = (session as any)._handleAgentEvent;

		await expect(
			emit({
				type: "tool_execution_start",
				toolCallId: "n1",
				toolName: "bash",
				args: { command: "head notes.txt" },
			}),
		).resolves.toBeUndefined();
		expect(session.activeSystem2Snapshot).toBeNull();

		await emit({
			type: "tool_execution_end",
			toolCallId: "n1",
			toolName: "bash",
			result: { content: [{ text: "FAILED to parse header\nError: malformed line 3" }] },
			isError: false,
		});

		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
		expect(readFileSync(join(dir, "notes.txt"), "utf-8")).toBe("keep me\n");
		// No mutation: no rollback feedback, no feedback message, no snapshot, no trajectory record.
		expect(session.lastSystem2Feedback).toBeNull();
		expect(session.messages.some((m) => m.role === "custom" && m.customType === "system2-feedback")).toBe(false);
		expect(session.activeSystem2Snapshot).toBeNull();
		expect(existsSync(session.system2TrajectoryLogger.filePath)).toBe(false);
	});

	it("does not roll back a failing read-only bash in git repo with no prior mutation", async () => {
		const emit = (session as any)._handleAgentEvent;
		writeFileSync(join(dir, "grep.log"), "match FAILED here\n");
		execSync("git add grep.log && git commit -m log", { cwd: dir });

		await expect(
			emit({
				type: "tool_execution_start",
				toolCallId: "g1",
				toolName: "bash",
				args: { command: "grep -c x nope" },
			}),
		).resolves.toBeUndefined();
		expect(session.activeSystem2Snapshot).not.toBeNull();

		await emit({
			type: "tool_execution_end",
			toolCallId: "g1",
			toolName: "bash",
			result: { content: [{ text: "grep: nope: No such file or directory\nError: no matches" }] },
			isError: true,
		});

		expect(existsSync(join(dir, "grep.log"))).toBe(true);
		expect(execSync("git status --porcelain", { cwd: dir }).toString().trim()).toBe("");
		// Clean git repo + no prior mutation: no rollback feedback, no feedback message,
		// no trajectory record, and the read-only command's worktree stays untouched.
		expect(session.lastSystem2Feedback).toBeNull();
		expect(session.messages.some((m) => m.role === "custom" && m.customType === "system2-feedback")).toBe(false);
		expect(session.activeSystem2Snapshot).toBeNull();
		expect(existsSync(session.system2TrajectoryLogger.filePath)).toBe(false);
	});

	it("still rolls back after edit -> failing test and restores files cleanly", async () => {
		const emit = (session as any)._handleAgentEvent;
		await emit({
			type: "tool_execution_start",
			toolCallId: "m1",
			toolName: "edit",
			args: { path: join(dir, "calc.ts") },
		});
		writeFileSync(join(dir, "calc.ts"), "export const add = (a: number, b: number) => a - b;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "m1",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		await expect(
			emit({ type: "tool_execution_start", toolCallId: "m2", toolName: "bash", args: { command: "npm test" } }),
		).resolves.toBeUndefined();
		await emit({
			type: "tool_execution_end",
			toolCallId: "m2",
			toolName: "bash",
			result: { content: [{ text: "FAILED calc.test.ts\nAssertionError: expected 1 to equal 3" }] },
			isError: false,
		});

		expect(session.lastSystem2Feedback).toContain("[System 2 Rollback]");
		expect(readFileSync(join(dir, "calc.ts"), "utf-8")).toBe("export const add = (a: number, b: number) => a + b;\n");
		expect(execSync("git status --porcelain", { cwd: dir }).toString().trim()).toBe("");
	});

	it("edit -> passing non-test bash (ls) -> failing read-only grep preserves edit, then failing vitest still rolls back", async () => {
		const emit = (session as any)._handleAgentEvent;
		const edited = "export const add = (a: number, b: number) => a * b;\n";

		await emit({
			type: "tool_execution_start",
			toolCallId: "p1",
			toolName: "edit",
			args: { path: join(dir, "calc.ts") },
		});
		writeFileSync(join(dir, "calc.ts"), edited);
		await emit({
			type: "tool_execution_end",
			toolCallId: "p1",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		// Passing non-test bash (ls) must not break tracking or revert edit.
		await emit({ type: "tool_execution_start", toolCallId: "p2", toolName: "bash", args: { command: "ls" } });
		await emit({
			type: "tool_execution_end",
			toolCallId: "p2",
			toolName: "bash",
			result: { content: [{ text: "calc.ts\n" }] },
			isError: false,
		});

		// Failing read-only grep must NOT wipe the pending edit or emit rollback feedback.
		await emit({
			type: "tool_execution_start",
			toolCallId: "p3",
			toolName: "bash",
			args: { command: "grep nope calc.ts" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "p3",
			toolName: "bash",
			result: { content: [{ text: "" }] },
			isError: true,
		});

		expect(readFileSync(join(dir, "calc.ts"), "utf-8")).toBe(edited);
		expect(session.lastSystem2Feedback).toBeNull();
		expect(existsSync(session.system2TrajectoryLogger.filePath)).toBe(false);
		expect(session.activeSystem2Snapshot).not.toBeNull();

		// A subsequent real failing test STILL rolls back calc.ts cleanly.
		await emit({
			type: "tool_execution_start",
			toolCallId: "p4",
			toolName: "bash",
			args: { command: "vitest --run" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "p4",
			toolName: "bash",
			result: { content: [{ text: "FAIL calc.test.ts" }] },
			isError: true,
		});
		expect(readFileSync(join(dir, "calc.ts"), "utf-8")).toBe("export const add = (a: number, b: number) => a + b;\n");
		expect(session.lastSystem2Feedback).toContain("[System 2 Rollback]");
	});

	it("clears snapshot on passing read-only bash and on agent_end so user commits across prompts are never wiped", async () => {
		const emit = (session as any)._handleAgentEvent;

		// Prompt 1: passing read-only git status clears snapshot immediately.
		await emit({ type: "agent_start" });
		await emit({
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "bash",
			args: { command: "git status" },
		});
		expect(session.activeSystem2Snapshot).not.toBeNull();
		await emit({
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "bash",
			result: { content: [{ text: "On branch main\nnothing to commit" }] },
			isError: false,
		});
		expect(session.activeSystem2Snapshot).toBeNull();

		// Even if an edit happened and agent_end fires before tests ran, agent_end clears transient state.
		await emit({
			type: "tool_execution_start",
			toolCallId: "r2",
			toolName: "edit",
			args: { path: join(dir, "calc.ts") },
		});
		writeFileSync(join(dir, "calc.ts"), "export const add = (a: number, b: number) => a + b + 1;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "r2",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});
		await emit({ type: "agent_end", messages: [] });
		expect(session.activeSystem2Snapshot).toBeNull();

		// User commits their work between prompts.
		execSync("git add calc.ts && git commit -m user-commit", { cwd: dir });
		const userHead = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();

		// Prompt 2: failing read-only rg must never reset userHead.
		await emit({ type: "agent_start" });
		await emit({
			type: "tool_execution_start",
			toolCallId: "r3",
			toolName: "bash",
			args: { command: "rg TODO" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "r3",
			toolName: "bash",
			result: { content: [{ text: "" }] },
			isError: true,
		});
		expect(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim()).toBe(userHead);
		expect(session.lastSystem2Feedback).toBeNull();
	});

	it("recognizes single-space 'Tests passed' output as passing verification", async () => {
		const emit = (session as any)._handleAgentEvent;
		const updated = "export const add = (a: number, b: number) => a + b + 0;\n";

		await emit({
			type: "tool_execution_start",
			toolCallId: "s1",
			toolName: "edit",
			args: { path: join(dir, "calc.ts") },
		});
		writeFileSync(join(dir, "calc.ts"), updated);
		await emit({
			type: "tool_execution_end",
			toolCallId: "s1",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});

		await emit({ type: "tool_execution_start", toolCallId: "s2", toolName: "bash", args: { command: "npm test" } });
		await emit({
			type: "tool_execution_end",
			toolCallId: "s2",
			toolName: "bash",
			result: { content: [{ text: "Tests passed" }] },
			isError: false,
		});

		expect(session.activeSystem2Snapshot).toBeNull();
		expect((session.state as any).deliberation?.status).toBe("pass");
	});

	it("emits a single [System 2 Rollback Failed] message without overwrite when rollback fails, and [System 2 Guard] on non-git post-guard", async () => {
		const emit = (session as any)._handleAgentEvent;

		// Trigger rollback failure by locking .git/index.lock before failing test.
		await emit({
			type: "tool_execution_start",
			toolCallId: "f1",
			toolName: "edit",
			args: { path: join(dir, "calc.ts") },
		});
		writeFileSync(join(dir, "calc.ts"), "export const add = (a: number, b: number) => a - b;\n");
		await emit({
			type: "tool_execution_end",
			toolCallId: "f1",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});
		writeFileSync(join(dir, ".git", "index.lock"), "locked");

		await emit({ type: "tool_execution_start", toolCallId: "f2", toolName: "bash", args: { command: "npm test" } });
		await emit({
			type: "tool_execution_end",
			toolCallId: "f2",
			toolName: "bash",
			result: { content: [{ text: "FAIL calc.test.ts" }] },
			isError: true,
		});

		const feedbackMsgs = session.messages.filter((m) => m.role === "custom" && m.customType === "system2-feedback");
		expect(feedbackMsgs).toHaveLength(1);
		expect(session.lastSystem2Feedback).toContain("[System 2 Rollback Failed]");
		expect(session.lastSystem2Feedback).toContain("disk was NOT restored");
		expect(session.lastSystem2Feedback).not.toContain("latency: 0ms");

		// Non-git post-guard failure must emit [System 2 Guard], not [System 2 Rollback].
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		const emptyFile = join(dir, "empty-nongit.ts");
		await emit({
			type: "tool_execution_start",
			toolCallId: "f3",
			toolName: "write",
			args: { path: emptyFile, content: "export const ok = 1;\n" },
		});
		writeFileSync(emptyFile, "");
		await expect(
			emit({
				type: "tool_execution_end",
				toolCallId: "f3",
				toolName: "write",
				result: { content: [] },
				isError: false,
			}),
		).rejects.toThrow(/Post-execution verification failed/);
		expect(session.lastSystem2Feedback).toContain("[System 2 Guard]");
		expect(session.lastSystem2Feedback).not.toContain("[System 2 Rollback]");
	});

	it("ignores errored write/edit (isError: true) so failed edits neither arm rollback nor log bogus passing fixes", async () => {
		const emit = (session as any)._handleAgentEvent;
		const calcPath = join(dir, "calc.ts");

		// Create a pending pre_guard rejection first so we can verify an errored edit doesn't resolve it.
		await expect(
			emit({
				type: "tool_execution_start",
				toolCallId: "e0",
				toolName: "write",
				args: { path: join(dir, "bad.ts"), content: "export const broken = (;" },
			}),
		).rejects.toThrow(/Blocked execution/);
		expect(session.system2TrajectoryLogger.hasPendingRejection()).toBe(true);

		// Errored edit (e.g. oldText not found / truncated tool call) with untouched existing file.
		await emit({
			type: "tool_execution_start",
			toolCallId: "e1",
			toolName: "edit",
			args: { path: calcPath, oldText: "missing", newText: "x" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "e1",
			toolName: "edit",
			result: { content: [{ text: "oldText not found" }] },
			isError: true,
		});

		// Must NOT resolve the pending rejection and must clear the unused snapshot.
		expect(session.system2TrajectoryLogger.hasPendingRejection()).toBe(true);
		expect(session.activeSystem2Snapshot).toBeNull();

		// Subsequent failing non-mutating bash must NOT emit rollback blaming edit.
		const prevFeedback = session.lastSystem2Feedback;
		await emit({ type: "tool_execution_start", toolCallId: "e2", toolName: "bash", args: { command: "npm test" } });
		await emit({
			type: "tool_execution_end",
			toolCallId: "e2",
			toolName: "bash",
			result: { content: [{ text: "FAIL suite" }] },
			isError: true,
		});
		expect(session.lastSystem2Feedback).toBe(prevFeedback);
	});

	it("hardens parallel tool batches against pre-guard abort leaks and mid-edit bash rollback", async () => {
		const emit = (session as any)._handleAgentEvent;
		const calcPath = join(dir, "calc.ts");

		// Batch 1: edit starts, then sibling write throws in pre-guard -> cleans up leaked state.
		await emit({
			type: "tool_execution_start",
			toolCallId: "par1",
			toolName: "edit",
			args: { path: calcPath },
		});
		expect(session.activeSystem2Snapshot).not.toBeNull();
		await expect(
			emit({
				type: "tool_execution_start",
				toolCallId: "par2",
				toolName: "write",
				args: { path: join(dir, "bad-syntax.ts"), content: "export const z = (;" },
			}),
		).rejects.toThrow(/Blocked execution/);
		expect(session.activeSystem2Snapshot).toBeNull();
		expect((session as any)._activeToolArgs.size).toBe(0);

		// Batch 2: concurrent [edit(in-flight), bash(failing)] must not roll back out from under edit.
		const inProgress = "export const add = (a: number, b: number) => a + b + 42;\n";
		await emit({
			type: "tool_execution_start",
			toolCallId: "par3",
			toolName: "edit",
			args: { path: calcPath },
		});
		await emit({
			type: "tool_execution_start",
			toolCallId: "par4",
			toolName: "bash",
			args: { command: "npm test" },
		});
		writeFileSync(calcPath, inProgress);
		await emit({
			type: "tool_execution_end",
			toolCallId: "par4",
			toolName: "bash",
			result: { content: [{ text: "FAIL concurrent" }] },
			isError: true,
		});
		// Edit is still in flight -> calc.ts must remain intact and snapshot must not be wiped mid-edit.
		expect(readFileSync(calcPath, "utf-8")).toBe(inProgress);
		expect(session.activeSystem2Snapshot).not.toBeNull();

		// Finish edit cleanly.
		await emit({
			type: "tool_execution_end",
			toolCallId: "par3",
			toolName: "edit",
			result: { content: [{ text: "ok" }] },
			isError: false,
		});
		expect((session as any)._inFlightMutatingToolIds.size).toBe(0);
	});
});

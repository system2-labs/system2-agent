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
});

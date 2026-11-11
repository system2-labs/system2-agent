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

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "s2-sess-test-"));
		execSync("git init -b main && git config user.name T && git config user.email t@t.com", { cwd: dir });
		writeFileSync(join(dir, "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
		execSync("git add calc.ts && git commit -m c", { cwd: dir });

		const agent = new Agent({
			getApiKey: () => "k",
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
		});
	});

	afterEach(() => {
		session?.dispose();
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
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
});

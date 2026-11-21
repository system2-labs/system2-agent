import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildAgyChildEnv,
	detectAgyAuthOrQuotaError,
	parseAgyModelCatalog,
	parseAgyStreamJsonOutput,
	resolveAgyModelAndEffort,
	runAgyPrompt,
	setupIsolatedAgyHome,
} from "../src/core/system2/agy-bridge.ts";

type RunnerCall = {
	cmd: string;
	args: readonly string[];
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number };
};

describe("parseAgyModelCatalog", () => {
	it("parses model lines, skips noise lines, and groups efforts in low/medium/high order", () => {
		const catalog = parseAgyModelCatalog(
			[
				"Available models:",
				"",
				"  fetching models from account...",
				"gemini-3.8-flash-high",
				"gemini-3.8-flash",
				"gemini-3.8-flash-medium",
				"gemini-3.8-flash-low",
				"claude-sonnet-4-6",
				"error: could not list models",
				"-- 7 models total",
			].join("\n"),
		);
		expect(catalog["gemini-3.8-flash"]).toEqual(["low", "medium", "high"]);
		expect(catalog["claude-sonnet-4-6"]).toEqual([]);
		expect(Object.keys(catalog).sort()).toEqual(["claude-sonnet-4-6", "gemini-3.8-flash"]);
	});
});

describe("resolveAgyModelAndEffort", () => {
	it("defaults to gemini-3.8-flash medium", () => {
		expect(resolveAgyModelAndEffort()).toEqual({ model: "gemini-3.8-flash", effort: "medium" });
	});

	it("resolves effort suffixes and provider prefixes", () => {
		expect(resolveAgyModelAndEffort("gemini-3.8-flash-high")).toEqual({ model: "gemini-3.8-flash", effort: "high" });
		expect(resolveAgyModelAndEffort("agy/gemini-3.7-flash-low")).toEqual({
			model: "gemini-3.7-flash",
			effort: "low",
		});
		expect(resolveAgyModelAndEffort("antigravity/gemini-3.8-flash")).toEqual({
			model: "gemini-3.8-flash",
			effort: "medium",
		});
	});

	it("resolves aliases and clamps effort to the supported list", () => {
		expect(resolveAgyModelAndEffort("sonnet", "high")).toEqual({ model: "claude-sonnet-4-6" });
		expect(resolveAgyModelAndEffort("pro", "medium")).toEqual({ model: "gemini-3.1-pro", effort: "high" });
		expect(resolveAgyModelAndEffort("opus", "none")).toEqual({ model: "claude-opus-4-6-thinking" });
		expect(resolveAgyModelAndEffort("gpt-oss-120b", "low")).toEqual({ model: "gpt-oss-120b", effort: "medium" });
		expect(resolveAgyModelAndEffort("some-future-model", "max")).toEqual({
			model: "some-future-model",
			effort: "medium",
		});
	});
});

describe("isolated agy home and child env", () => {
	it("symlinks the OAuth token into the temp HOME and cleanup removes it", () => {
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-real-"));
		const tokenDir = join(realHome, ".gemini", "antigravity-cli");
		mkdirSync(tokenDir, { recursive: true });
		writeFileSync(join(tokenDir, "antigravity-oauth-token"), "fake-token");
		try {
			const { tempHome, cleanup } = setupIsolatedAgyHome(realHome);
			expect(existsSync(tempHome)).toBe(true);
			expect(
				lstatSync(join(tempHome, ".gemini", "antigravity-cli", "antigravity-oauth-token")).isSymbolicLink(),
			).toBe(true);
			cleanup();
			expect(existsSync(tempHome)).toBe(false);
		} finally {
			rmSync(realHome, { recursive: true, force: true });
		}
	});

	it("strips secret env keys, keeps PATH, and points HOME at the temp home", () => {
		const env = buildAgyChildEnv(
			{
				PATH: "/usr/bin",
				HOME: "/Users/someone",
				EDITOR: "vim",
				OPENAI_API_KEY: "sk-secret",
				ANTHROPIC_API_KEY: "ant-secret",
				AWS_SECRET_ACCESS_KEY: "aws-secret",
				GITHUB_TOKEN: "gh-secret",
				DB_PASSWORD: "pw",
			} as NodeJS.ProcessEnv,
			"/tmp/fake-agy-home",
		);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.EDITOR).toBe("vim");
		expect(env.HOME).toBe("/tmp/fake-agy-home");
		expect(env.AGY_DISABLE_AUTO_UPDATE).toBe("1");
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.DB_PASSWORD).toBeUndefined();
	});
});

describe("detectAgyAuthOrQuotaError", () => {
	it("classifies quota, auth contention, and clean output", () => {
		expect(detectAgyAuthOrQuotaError("Model usage: 0% remaining")).toEqual({
			kind: "quota",
			detail: expect.stringMatching(/0%\s+remaining/),
		});
		expect(detectAgyAuthOrQuotaError("API error: Error getting token source (lock busy)")).toEqual({
			kind: "auth_contention",
			detail: expect.stringMatching(/error getting token source/i),
		});
		expect(detectAgyAuthOrQuotaError("all good, here is your answer")).toEqual({ kind: "none" });
	});
});

describe("runAgyPrompt", () => {
	it("builds the exact CLI args, parses JSONL stream output, and cleans up the temp HOME", async () => {
		const calls: RunnerCall[] = [];
		const runner = (cmd: string, args: readonly string[], options: RunnerCall["options"]) => {
			calls.push({ cmd, args, options });
			return {
				stdout:
					JSON.stringify({ type: "message", content: "part one " }) +
					"\n" +
					JSON.stringify({ type: "message", content: "part two", conversation_id: "conv-42" }) +
					"\n",
				stderr: "",
				exitCode: 0,
			};
		};
		const result = await runAgyPrompt({ prompt: "design the bridge", model: "gemini-3.8-flash-high", runner });
		expect(result).toEqual({
			ok: true,
			text: "part one\npart two",
			model: "gemini-3.8-flash",
			effort: "high",
			conversationId: "conv-42",
		});
		expect(calls[0].cmd.endsWith("/agy") || calls[0].cmd === "agy").toBe(true);
		expect(calls[0].args).toEqual(["-p", "design the bridge", "--model", "gemini-3.8-flash", "--effort", "high"]);
		expect(calls[0].options.timeoutMs).toBe(300_000);
		const tempHome = calls[0].options.env?.HOME;
		expect(tempHome).toBeTruthy();
		expect(tempHome).not.toBe(process.env.HOME);
		expect(existsSync(tempHome as string)).toBe(false);
	});

	it("omits --effort for models with no supported efforts", async () => {
		const calls: RunnerCall[] = [];
		const runner = (cmd: string, args: readonly string[], options: RunnerCall["options"]) => {
			calls.push({ cmd, args, options });
			return { stdout: "plain text answer", stderr: "", exitCode: 0 };
		};
		const result = await runAgyPrompt({ prompt: "summarize", model: "sonnet", isolateHome: false, runner });
		expect(result.ok).toBe(true);
		expect(result.text).toBe("plain text answer");
		expect(result.model).toBe("claude-sonnet-4-6");
		expect(calls[0].args).toEqual(["-p", "summarize", "--model", "claude-sonnet-4-6"]);
	});

	it("maps quota output to a failed result with errorKind quota", async () => {
		const runner = () => ({
			stdout: "Error: resource_exhausted: 0% remaining on your plan",
			stderr: "",
			exitCode: 1,
		});
		const result = await runAgyPrompt({ prompt: "x", model: "flash", isolateHome: false, runner });
		expect(result.ok).toBe(false);
		expect(result.model).toBe("gemini-3.8-flash");
		expect(result.errorKind).toBe("quota");
		expect(result.errorDetail).toMatch(/resource_exhausted/);
	});
});

describe("parseAgyStreamJsonOutput", () => {
	it("falls back to the raw trimmed text when no JSON lines matched", () => {
		expect(parseAgyStreamJsonOutput("  just some plain output  ")).toEqual({ text: "just some plain output" });
	});
});

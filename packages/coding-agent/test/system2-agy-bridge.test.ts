import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AGY_OAUTH_TOKEN_FILENAMES,
	buildAgyChildEnv,
	detectAgyAuthOrQuotaError,
	parseAgyModelCatalog,
	parseAgyStreamJsonOutput,
	resolveAgyModelAndEffort,
	resolveRealAgyTokenPath,
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

describe("resolveRealAgyTokenPath", () => {
	it("prefers jetski-standalone-oauth-token over antigravity-oauth-token when both exist", () => {
		expect(AGY_OAUTH_TOKEN_FILENAMES).toEqual(["jetski-standalone-oauth-token", "antigravity-oauth-token"]);
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-token-prio-"));
		const tokenDir = join(realHome, ".gemini", "antigravity-cli");
		mkdirSync(tokenDir, { recursive: true });
		writeFileSync(join(tokenDir, "antigravity-oauth-token"), "legacy-token");
		writeFileSync(join(tokenDir, "jetski-standalone-oauth-token"), "new-token");
		try {
			expect(resolveRealAgyTokenPath(realHome, {})).toEqual({
				path: join(tokenDir, "jetski-standalone-oauth-token"),
				filename: "jetski-standalone-oauth-token",
			});
		} finally {
			rmSync(realHome, { recursive: true, force: true });
		}
	});

	it("falls back to antigravity-oauth-token when only the legacy token exists", () => {
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-token-legacy-"));
		const tokenDir = join(realHome, ".gemini", "antigravity-cli");
		mkdirSync(tokenDir, { recursive: true });
		writeFileSync(join(tokenDir, "antigravity-oauth-token"), "legacy-token");
		try {
			expect(resolveRealAgyTokenPath(realHome, { ANTIGRAVITY_CONFIG_DIR: "   " })).toEqual({
				path: join(tokenDir, "antigravity-oauth-token"),
				filename: "antigravity-oauth-token",
			});
		} finally {
			rmSync(realHome, { recursive: true, force: true });
		}
	});

	it("isolates resolution to ANTIGRAVITY_CONFIG_DIR without falling back to realHomeDir", () => {
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-home-fallback-"));
		const configDir = mkdtempSync(join(tmpdir(), "s2-agy-config-dir-"));
		const homeTokenDir = join(realHome, ".gemini", "antigravity-cli");
		mkdirSync(homeTokenDir, { recursive: true });
		writeFileSync(join(homeTokenDir, "jetski-standalone-oauth-token"), "home-token");
		try {
			// Empty explicit config dir must NOT fall back to realHome.
			expect(resolveRealAgyTokenPath(realHome, { ANTIGRAVITY_CONFIG_DIR: `  ${configDir}  ` })).toBeUndefined();

			writeFileSync(join(configDir, "antigravity-oauth-token"), "cfg-legacy");
			expect(resolveRealAgyTokenPath(realHome, { ANTIGRAVITY_CONFIG_DIR: configDir })).toEqual({
				path: join(configDir, "antigravity-oauth-token"),
				filename: "antigravity-oauth-token",
			});

			writeFileSync(join(configDir, "jetski-standalone-oauth-token"), "cfg-new");
			expect(resolveRealAgyTokenPath(realHome, { ANTIGRAVITY_CONFIG_DIR: configDir })).toEqual({
				path: join(configDir, "jetski-standalone-oauth-token"),
				filename: "jetski-standalone-oauth-token",
			});
		} finally {
			rmSync(realHome, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});

describe("isolated agy home and child env", () => {
	it("enforces 0o700 on tempHome, symlinks the OAuth token preserving basename, and unlinks symlinks without touching targets", () => {
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-real-"));
		const tokenDir = join(realHome, ".gemini", "antigravity-cli");
		mkdirSync(tokenDir, { recursive: true });
		const legacyPath = join(tokenDir, "antigravity-oauth-token");
		const jetskiPath = join(tokenDir, "jetski-standalone-oauth-token");
		writeFileSync(legacyPath, "legacy-token");
		writeFileSync(jetskiPath, "jetski-token");
		try {
			const { tempHome, linkedPaths, cleanup } = setupIsolatedAgyHome({ realHomeDir: realHome, env: {} });
			expect(existsSync(tempHome)).toBe(true);
			expect(statSync(tempHome).mode & 0o777).toBe(0o700);
			const expectedLink = join(tempHome, ".gemini", "antigravity-cli", "jetski-standalone-oauth-token");
			expect(lstatSync(expectedLink).isSymbolicLink()).toBe(true);
			expect(readlinkSync(expectedLink)).toBe(jetskiPath);
			expect(linkedPaths).toEqual([expectedLink]);
			cleanup();
			expect(existsSync(tempHome)).toBe(false);
			expect(readFileSync(jetskiPath, "utf8")).toBe("jetski-token");
			expect(readFileSync(legacyPath, "utf8")).toBe("legacy-token");
			// Idempotent second call must not throw.
			cleanup();
		} finally {
			rmSync(realHome, { recursive: true, force: true });
		}
	});

	it("accepts a plain string realHomeDir for backward compatibility", () => {
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-real-str-"));
		const tokenDir = join(realHome, ".gemini", "antigravity-cli");
		mkdirSync(tokenDir, { recursive: true });
		writeFileSync(join(tokenDir, "antigravity-oauth-token"), "fake-token");
		const prevConfigDir = process.env.ANTIGRAVITY_CONFIG_DIR;
		delete process.env.ANTIGRAVITY_CONFIG_DIR;
		try {
			const { tempHome, linkedPaths, cleanup } = setupIsolatedAgyHome(realHome);
			const tokenLink = join(tempHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
			expect(lstatSync(tokenLink).isSymbolicLink()).toBe(true);
			expect(linkedPaths).toContain(tokenLink);
			cleanup();
			expect(existsSync(tempHome)).toBe(false);
		} finally {
			if (prevConfigDir !== undefined) process.env.ANTIGRAVITY_CONFIG_DIR = prevConfigDir;
			rmSync(realHome, { recursive: true, force: true });
		}
	});

	it("gates macOS Library/Keychains symlinking and preserves target files on cleanup", () => {
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-keychains-"));
		const tokenDir = join(realHome, ".gemini", "antigravity-cli");
		const keychainsDir = join(realHome, "Library", "Keychains");
		const configDir = mkdtempSync(join(tmpdir(), "s2-agy-cfg-keychains-"));
		mkdirSync(tokenDir, { recursive: true });
		mkdirSync(keychainsDir, { recursive: true });
		const keychainFile = join(keychainsDir, "login.keychain-db");
		writeFileSync(keychainFile, "sentinel-keychain-bytes");
		const tokenPath = join(tokenDir, "jetski-standalone-oauth-token");
		writeFileSync(tokenPath, "file-token");

		try {
			// 1. Token file present + default linkKeychains -> Keychains is skipped.
			const withToken = setupIsolatedAgyHome({ realHomeDir: realHome, env: {} });
			const keychainsLink1 = join(withToken.tempHome, "Library", "Keychains");
			expect(existsSync(keychainsLink1)).toBe(false);
			expect(withToken.linkedPaths).toEqual([
				join(withToken.tempHome, ".gemini", "antigravity-cli", "jetski-standalone-oauth-token"),
			]);
			withToken.cleanup();

			// 2. Token file present + linkKeychains: true -> Keychains linked on darwin, unlinked cleanly on cleanup.
			const forced = setupIsolatedAgyHome({ realHomeDir: realHome, env: {}, linkKeychains: true });
			const keychainsLink2 = join(forced.tempHome, "Library", "Keychains");
			if (platform() === "darwin") {
				expect(lstatSync(keychainsLink2).isSymbolicLink()).toBe(true);
				expect(forced.linkedPaths).toEqual([
					join(forced.tempHome, ".gemini", "antigravity-cli", "jetski-standalone-oauth-token"),
					keychainsLink2,
				]);
			} else {
				expect(existsSync(keychainsLink2)).toBe(false);
			}
			forced.cleanup();
			expect(existsSync(forced.tempHome)).toBe(false);
			expect(readFileSync(keychainFile, "utf8")).toBe("sentinel-keychain-bytes");
			expect(readFileSync(tokenPath, "utf8")).toBe("file-token");

			// 3. Explicit ANTIGRAVITY_CONFIG_DIR -> NEVER links Keychains even when linkKeychains: true and no token exists.
			const withConfigDir = setupIsolatedAgyHome({
				realHomeDir: realHome,
				env: { ANTIGRAVITY_CONFIG_DIR: configDir },
				linkKeychains: true,
			});
			expect(existsSync(join(withConfigDir.tempHome, "Library", "Keychains"))).toBe(false);
			expect(withConfigDir.linkedPaths).toEqual([]);
			withConfigDir.cleanup();

			// 4. No token file on disk -> links Keychains on darwin by default, skips when linkKeychains: false.
			rmSync(tokenPath);
			const noTokenDefault = setupIsolatedAgyHome({ realHomeDir: realHome, env: {} });
			const keychainsLink4 = join(noTokenDefault.tempHome, "Library", "Keychains");
			if (platform() === "darwin") {
				expect(lstatSync(keychainsLink4).isSymbolicLink()).toBe(true);
				expect(noTokenDefault.linkedPaths).toEqual([keychainsLink4]);
			} else {
				expect(existsSync(keychainsLink4)).toBe(false);
			}
			noTokenDefault.cleanup();
			expect(readFileSync(keychainFile, "utf8")).toBe("sentinel-keychain-bytes");

			const noTokenDisabled = setupIsolatedAgyHome({ realHomeDir: realHome, env: {}, linkKeychains: false });
			expect(existsSync(join(noTokenDisabled.tempHome, "Library", "Keychains"))).toBe(false);
			expect(noTokenDisabled.linkedPaths).toEqual([]);
			noTokenDisabled.cleanup();
		} finally {
			rmSync(realHome, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("strips full Hermes secret regex patterns, preserves safe exceptions, and sets auto-update + HOME/USERPROFILE", () => {
		const env = buildAgyChildEnv(
			{
				PATH: "/usr/bin",
				HOME: "/Users/someone",
				USER: "someone",
				EDITOR: "vim",
				SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
				GPG_AGENT_INFO: "/tmp/gpg.sock:1:1",
				OPENAI_API_KEY: "sk-secret",
				ANTHROPIC_API_KEY: "ant-secret",
				AWS_SECRET_ACCESS_KEY: "aws-secret",
				GITHUB_TOKEN: "gh-secret",
				DB_PASSWORD: "pw",
				PASSWD: "pw2",
				PASSPHRASE: "secret phrase",
				PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
				WEBHOOK_URL: "https://hooks.example.com/abc",
				SENTRY_DSN: "https://key@sentry.example.com/1",
				SESSION_COOKIE: "sid=123",
				DATABASE_URL: "postgres://u:p@host/db",
				REDIS_URI: "redis://:pass@host:6379/0",
				AUTH_HEADER: "Bearer xyz",
				POSTGRES_URL: "postgres://host/db",
				MONGO_URI: "mongodb://host/db",
				AMQP_URL: "amqp://host",
				CACHE_URI: "redis://cache",
				CLIENT_CREDENTIALS: "cred",
				AGY_CLI_DISABLE_AUTO_UPDATE: "false",
			} as NodeJS.ProcessEnv,
			"/tmp/fake-agy-home",
		);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.USER).toBe("someone");
		expect(env.EDITOR).toBe("vim");
		expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
		expect(env.GPG_AGENT_INFO).toBe("/tmp/gpg.sock:1:1");
		expect(env.HOME).toBe("/tmp/fake-agy-home");
		expect(env.USERPROFILE).toBe("/tmp/fake-agy-home");
		expect(env.AGY_DISABLE_AUTO_UPDATE).toBe("1");
		expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
		for (const stripped of [
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
			"GITHUB_TOKEN",
			"DB_PASSWORD",
			"PASSWD",
			"PASSPHRASE",
			"PRIVATE_KEY",
			"WEBHOOK_URL",
			"SENTRY_DSN",
			"SESSION_COOKIE",
			"DATABASE_URL",
			"REDIS_URI",
			"AUTH_HEADER",
			"POSTGRES_URL",
			"MONGO_URI",
			"AMQP_URL",
			"CACHE_URI",
			"CLIENT_CREDENTIALS",
		]) {
			expect(env[stripped], `expected ${stripped} to be stripped`).toBeUndefined();
		}
	});

	it("preserves explicitly listed secrets via ANTIGRAVITY_ENV_PASSTHROUGH", () => {
		const env = buildAgyChildEnv({
			PATH: "/usr/bin",
			GITHUB_TOKEN: "gh-allowed",
			SENTRY_DSN: "https://allowed@sentry.example.com/1",
			OPENAI_API_KEY: "sk-still-stripped",
			ANTIGRAVITY_ENV_PASSTHROUGH: " GITHUB_TOKEN , SENTRY_DSN ",
		} as NodeJS.ProcessEnv);
		expect(env.GITHUB_TOKEN).toBe("gh-allowed");
		expect(env.SENTRY_DSN).toBe("https://allowed@sentry.example.com/1");
		expect(env.OPENAI_API_KEY).toBeUndefined();
	});

	it("enforces ANTIGRAVITY_ENV_STRICT allowlist mode with baseline, LC_*, ALLOWLIST, and PASSTHROUGH", () => {
		for (const strictFlag of ["1", "true", "YES", "On"]) {
			const env = buildAgyChildEnv(
				{
					ANTIGRAVITY_ENV_STRICT: strictFlag,
					ANTIGRAVITY_ENV_ALLOWLIST: "CUSTOM_SAFE, OTHER_FLAG",
					ANTIGRAVITY_ENV_PASSTHROUGH: "SPECIAL_TOKEN",
					PATH: "/usr/bin",
					HOME: "/Users/orig",
					USER: "alice",
					LANG: "en_US.UTF-8",
					LC_TIME: "C",
					HTTPS_PROXY: "http://proxy:8080",
					http_proxy: "http://proxy:8080",
					SSH_AUTH_SOCK: "/tmp/ssh.sock",
					AGY_CLI_MODEL_API_MAX_RETRIES: "3",
					CUSTOM_SAFE: "yes",
					OTHER_FLAG: "42",
					SPECIAL_TOKEN: "tok-allowed",
					EDITOR: "vim",
					UNLISTED_NON_SECRET: "drop-me",
					OPENAI_API_KEY: "sk-drop-me",
				} as NodeJS.ProcessEnv,
				"/tmp/strict-home",
			);
			expect(env.PATH).toBe("/usr/bin");
			expect(env.HOME).toBe("/tmp/strict-home");
			expect(env.USERPROFILE).toBe("/tmp/strict-home");
			expect(env.USER).toBe("alice");
			expect(env.LANG).toBe("en_US.UTF-8");
			expect(env.LC_TIME).toBe("C");
			expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
			expect(env.http_proxy).toBe("http://proxy:8080");
			expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
			expect(env.AGY_CLI_MODEL_API_MAX_RETRIES).toBe("3");
			expect(env.CUSTOM_SAFE).toBe("yes");
			expect(env.OTHER_FLAG).toBe("42");
			expect(env.SPECIAL_TOKEN).toBe("tok-allowed");
			expect(env.AGY_DISABLE_AUTO_UPDATE).toBe("1");
			expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
			expect(env.EDITOR).toBeUndefined();
			expect(env.UNLISTED_NON_SECRET).toBeUndefined();
			expect(env.OPENAI_API_KEY).toBeUndefined();
		}
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
		expect(calls[0].args).toEqual([
			"-p",
			"design the bridge",
			"--output-format",
			"stream-json",
			"--disable-slash-commands",
			"--model",
			"gemini-3.8-flash",
			"--effort",
			"high",
		]);
		expect(calls[0].options.timeoutMs).toBe(300_000);
		const tempHome = calls[0].options.env?.HOME;
		expect(tempHome).toBeTruthy();
		expect(tempHome).not.toBe(process.env.HOME);
		expect(calls[0].options.env?.USERPROFILE).toBe(tempHome);
		expect(calls[0].options.env?.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
		expect(existsSync(tempHome as string)).toBe(false);
	});

	it("supports optional --mode, custom outputFormat, disableSlashCommands=false, and conversationId", async () => {
		const calls: RunnerCall[] = [];
		const runner = (cmd: string, args: readonly string[], options: RunnerCall["options"]) => {
			calls.push({ cmd, args, options });
			return { stdout: JSON.stringify({ result: "done" }), stderr: "", exitCode: 0 };
		};
		await runAgyPrompt({
			prompt: "audit module",
			model: "flash",
			effort: "low",
			mode: " agent ",
			conversationId: "conv-9",
			isolateHome: false,
			runner,
		});
		expect(calls[0].args).toEqual([
			"-p",
			"audit module",
			"--output-format",
			"stream-json",
			"--disable-slash-commands",
			"--mode",
			"agent",
			"--model",
			"gemini-3.8-flash",
			"--effort",
			"low",
			"--conversation",
			"conv-9",
		]);

		await runAgyPrompt({
			prompt: "raw",
			model: "sonnet",
			mode: "   ",
			outputFormat: "text",
			disableSlashCommands: false,
			isolateHome: false,
			runner,
		});
		expect(calls[1].args).toEqual(["-p", "raw", "--output-format", "text", "--model", "claude-sonnet-4-6"]);
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
		expect(calls[0].args).toEqual([
			"-p",
			"summarize",
			"--output-format",
			"stream-json",
			"--disable-slash-commands",
			"--model",
			"claude-sonnet-4-6",
		]);
	});

	it("forwards realHomeDir and linkKeychains into setupIsolatedAgyHome", async () => {
		const realHome = mkdtempSync(join(tmpdir(), "s2-agy-run-kc-"));
		const tokenDir = join(realHome, ".gemini", "antigravity-cli");
		const keychainsDir = join(realHome, "Library", "Keychains");
		mkdirSync(tokenDir, { recursive: true });
		mkdirSync(keychainsDir, { recursive: true });
		writeFileSync(join(tokenDir, "jetski-standalone-oauth-token"), "tok");
		const prevConfigDir = process.env.ANTIGRAVITY_CONFIG_DIR;
		delete process.env.ANTIGRAVITY_CONFIG_DIR;
		let sawKeychainsLink = false;
		try {
			await runAgyPrompt({
				prompt: "check",
				model: "sonnet",
				realHomeDir: realHome,
				linkKeychains: true,
				runner: (_cmd, _args, options) => {
					const home = options.env?.HOME as string;
					const kcLink = join(home, "Library", "Keychains");
					sawKeychainsLink = existsSync(kcLink) && lstatSync(kcLink).isSymbolicLink();
					return { stdout: "ok", stderr: "", exitCode: 0 };
				},
			});
			expect(sawKeychainsLink).toBe(platform() === "darwin");
		} finally {
			if (prevConfigDir !== undefined) process.env.ANTIGRAVITY_CONFIG_DIR = prevConfigDir;
			rmSync(realHome, { recursive: true, force: true });
		}
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

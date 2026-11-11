import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, CONFIG_DIR_NAME } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	createSystem2AutoModel,
	createSystem2DeliberativeModel,
	formatSystem2FooterModel,
	getModelNickname,
} from "../src/core/system2/index.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("System 2 CLI Insights, Prompt Collision Fix & Update Decoupling", () => {
	const originalEnv = { ...process.env };

	beforeAll(() => {
		initTheme(undefined, false);
	});

	beforeEach(() => {
		delete process.env.SYSTEM2_VERBOSE_ROUTING;
		delete process.env.SYSTEM2_SKIP_UPSTREAM_UPDATES;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	describe("no_prompt_collision", () => {
		it("virtual model routing suppresses raw console.error writes during interactive execution", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});

			const faux = fauxProvider({
				models: [
					{ id: "gpt-4o", contextWindow: 128_000, maxTokens: 4096, input: ["text"] },
					{ id: "o3-mini", contextWindow: 200_000, maxTokens: 16_000, input: ["text"], reasoning: true },
				],
			});
			runtime.registerNativeProvider(faux.provider);
			runtime.registerVirtualModel(createSystem2AutoModel(runtime));
			runtime.registerVirtualModel(createSystem2DeliberativeModel(runtime));
			await runtime.refresh({ allowNetwork: false });

			const autoModel = runtime.getModel("system2", "auto")!;
			const deliberativeModel = runtime.getModel("system2", "deliberative")!;

			// 1. Resolve auto model with default silent routing
			await runtime.resolveModel(
				autoModel,
				[{ role: "user", content: "def solve(x): return x * 2", timestamp: Date.now() }],
				{ reason: "user", thinkingLevel: "low" },
			);
			expect(errorSpy).not.toHaveBeenCalled();

			// 2. Resolve deliberative model with default silent routing
			await runtime.resolveModel(
				deliberativeModel,
				[{ role: "user", content: "Prove the theorem via resolution", timestamp: Date.now() }],
				{ reason: "user", thinkingLevel: "high" },
			);
			expect(errorSpy).not.toHaveBeenCalled();

			// 3. Enabling SYSTEM2_VERBOSE_ROUTING restores telemetry on stderr
			process.env.SYSTEM2_VERBOSE_ROUTING = "1";
			await runtime.resolveModel(
				autoModel,
				[{ role: "user", content: "def solve(x): return x * 2", timestamp: Date.now() }],
				{ reason: "user", thinkingLevel: "low" },
			);
			expect(errorSpy).toHaveBeenCalled();
		});
	});

	describe("model_nickname_insights", () => {
		it("maps physical model IDs to clean cognitive nicknames", () => {
			const cases: Array<[string, string]> = [
				["qwen3.5-9b", "Artisan"],
				["Qwen3.5-9B-Instruct", "Artisan"],
				["qwen-3.8-27b-intermediate@iq3_xxs", "Sweetspot"],
				["qwen-3.8-27b-intermediate@q2_k_xl", "Sub-Ten"],
				["qwen-3.8-27b-smoll", "Smoll"],
				["gemma-4-e2b-it-qat", "Gatekeeper"],
				["deepseek-v4-pro-qwen3.5-9b-uncensored-heretic", "Heretic"],
				["qwen3-vl-4b-instruct", "Ocular"],
				["lfm2.5-1.2b-instruct", "Sentinel"],
				["lfm2-9b", "Sentinel"],
				["lfm3-2b-omni-abliter8", "Nightwatch"],
				["qwen3.8-splash-next", "Big-Brain"],
				["qwen3.8-27b-splash", "Splash"],
				["custom-unmapped-model", "custom-unmapped-model"],
			];
			for (const [id, expected] of cases) {
				expect(getModelNickname(id)).toBe(expected);
			}
		});

		it("renders Mondrian palette indicators and thinking levels", () => {
			// Sys1 (Cadmium Red: #EF4223 -> rgb(239, 66, 35))
			const sys1Formatted = formatSystem2FooterModel(
				{ model: { id: "qwen3.5-9b", provider: "system2" }, thinkingLevel: "low" },
				{ track: "code", system: 1 },
			);
			expect(sys1Formatted).toBe("\x1b[38;2;239;66;35m[Sys1: code]\x1b[0m Artisan • low");

			// Sys2 (Cobalt Blue: #3D8BAA -> rgb(61, 139, 170))
			const sys2Formatted = formatSystem2FooterModel(
				{ model: { id: "qwen-3.8-27b-intermediate@iq3_xxs", provider: "system2" }, thinkingLevel: "high" },
				{ track: "logic", system: 2 },
			);
			expect(sys2Formatted).toBe("\x1b[38;2;61;139;170m[Sys2: logic]\x1b[0m Sweetspot • high");

			// Sentinel (Cadmium Yellow: #FFB703 -> rgb(255, 183, 3))
			const sentinelFormatted = formatSystem2FooterModel(
				{ model: { id: "lfm2.5-1.2b-instruct", provider: "system2" } },
				{ isSentinel: true },
			);
			expect(sentinelFormatted).toBe("\x1b[38;2;255;183;3m[Sentinel]\x1b[0m Sentinel");
		});

		it("footer component integrates System 2 Mondrian formatting", () => {
			const mockSession = {
				sessionManager: {
					getCwd: () => "/workspace/test",
					getSessionName: () => undefined,
					getEntryCount: () => 0,
					getSessionId: () => "s2",
					getLeafId: () => null,
					getEntries: () => [],
				},
				state: { model: { id: "auto", provider: "system2" }, thinkingLevel: "low", track: "code" },
				routedModel: { model: { id: "qwen3.5-9b", provider: "system2" }, thinkingLevel: "low" },
				modelRuntime: { isUsingSubscription: () => false },
				getContextUsage: () => undefined,
			};
			const mockFooterData = {
				getGitBranch: () => "main",
				getAvailableProviderCount: () => 1,
				getExtensionStatuses: () => new Map(),
			};
			const footer = new FooterComponent(mockSession as any, mockFooterData as any);
			expect(footer.render(100)[1]).toContain("\x1b[38;2;239;66;35m[Sys1: code]\x1b[0m Artisan • low");
		});
	});

	describe("upstream_update_decoupling", () => {
		it("sets system2 branding in package.json and config", () => {
			expect(APP_NAME).toBe("system2");
			expect(CONFIG_DIR_NAME).toBe(".system2");

			const pkgPath = resolve(__dirname, "../package.json");
			expect(existsSync(pkgPath)).toBe(true);
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			expect(pkg.piConfig?.name).toBe("system2");
			expect(pkg.piConfig?.configDir).toBe(".system2");
			expect(pkg.bin?.system2).toBe("dist/bundle/cli.js");
		});

		it("bypasses upstream package update checks when running under system2 branding", async () => {
			const mockContext = {
				sessionManager: {
					getCwd: () => process.cwd(),
				},
				settingsManager: {},
			};

			// Calling private checkForPackageUpdates under system2 branding
			const checkForPackageUpdates = (
				InteractiveMode.prototype as unknown as {
					checkForPackageUpdates(this: typeof mockContext): Promise<string[]>;
				}
			).checkForPackageUpdates;

			const updates = await checkForPackageUpdates.call(mockContext);
			expect(updates).toEqual([]);

			// Also verify environment variable bypass
			process.env.SYSTEM2_SKIP_UPSTREAM_UPDATES = "1";
			const updatesWithEnv = await checkForPackageUpdates.call(mockContext);
			expect(updatesWithEnv).toEqual([]);
		});
	});
});

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
import { piLogoLines, piWordmark } from "../src/modes/interactive/components/pi-logo.ts";
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
			expect(sys1Formatted).toBe(
				"\x1b[38;2;239;66;35m[Sys1: code]\x1b[0m → \x1b[1mArtisan\x1b[0m (qwen3.5-9b) • low",
			);

			// Sys1 with confidence and runtime timing telemetry
			const sys1Rich = formatSystem2FooterModel(
				{ model: { id: "qwen3.5-9b", provider: "system2" }, thinkingLevel: "off" },
				{ track: "general", system: 1, confidence: 0.85, latency_ms: 120 },
			);
			expect(sys1Rich).toBe(
				"\x1b[38;2;239;66;35m[Sys1: general // 85% conf, took 0.1s]\x1b[0m → \x1b[1mArtisan\x1b[0m (qwen3.5-9b)",
			);

			// Sys2 (Cobalt Blue: #3D8BAA -> rgb(61, 139, 170))
			const sys2Formatted = formatSystem2FooterModel(
				{ model: { id: "qwen-3.8-27b-intermediate@iq3_xxs", provider: "system2" }, thinkingLevel: "high" },
				{ track: "logic", system: 2 },
			);
			expect(sys2Formatted).toBe(
				"\x1b[38;2;61;139;170m[Sys2: logic]\x1b[0m → \x1b[1mSweetspot\x1b[0m (qwen-3.8-27b-intermediate@iq3_xxs) • high",
			);

			// Sys2 with deliberation outcome pass + arbitration summary
			const sys2Rich = formatSystem2FooterModel(
				{ model: { id: "qwen3.5-9b", provider: "system2" }, thinkingLevel: "medium" },
				{
					track: "logic",
					system: 2,
					deliberation: {
						status: "pass",
						summary: "5 ThoughtHeads arbitrated: Artisan selected",
					},
				},
			);
			expect(sys2Rich).toBe(
				"\x1b[38;2;61;139;170m[Sys2: pass // 5 ThoughtHeads arbitrated: Artisan selected]\x1b[0m → \x1b[1mArtisan\x1b[0m (qwen3.5-9b) • medium",
			);

			// Sentinel (Cadmium Yellow: #FFB703 -> rgb(255, 183, 3))
			const sentinelFormatted = formatSystem2FooterModel(
				{ model: { id: "lfm2.5-1.2b-instruct", provider: "system2" } },
				{ isSentinel: true },
			);
			expect(sentinelFormatted).toBe(
				"\x1b[38;2;255;183;3m[Sentinel]\x1b[0m → \x1b[1mSentinel\x1b[0m (lfm2.5-1.2b-instruct)",
			);

			// Idle state before first user turn
			const idleSys2 = formatSystem2FooterModel(undefined, {
				model: { id: "deliberative" },
				thinkingLevel: "medium",
			});
			expect(idleSys2).toBe("\x1b[38;2;61;139;170m[Sys2: Deliberative]\x1b[0m • medium");

			const idleSys1 = formatSystem2FooterModel(undefined, { model: { id: "auto" }, thinkingLevel: "off" });
			expect(idleSys1).toBe("\x1b[38;2;239;66;35m[Sys1: Auto]\x1b[0m • off");
		});

		it("footer component renders clean 3-line layout with System 2 telemetry", () => {
			const mockSession = {
				sessionManager: {
					getCwd: () => "/workspace/test",
					getSessionName: () => undefined,
					getEntryCount: () => 0,
					getSessionId: () => "s2",
					getLeafId: () => null,
					getEntries: () => [],
				},
				state: {
					model: { id: "auto", provider: "system2", reasoning: true },
					thinkingLevel: "low",
					track: "code",
					confidence: 0.85,
					tookMs: 120,
				},
				routedModel: { model: { id: "qwen3.5-9b", provider: "system2" }, thinkingLevel: "low" },
				modelRuntime: { isUsingSubscription: () => false },
				getContextUsage: () => undefined,
				getActiveTool: () => ({ toolName: "bash", summary: "git status", persona: "Arbiter // Sandbox" }),
			};
			const mockFooterData = {
				getGitBranch: () => "main",
				getAvailableProviderCount: () => 1,
				getExtensionStatuses: () => new Map(),
			};
			const footer = new FooterComponent(mockSession as any, mockFooterData as any);
			const lines = footer.render(120);
			expect(lines).toHaveLength(3);
			expect(lines[1]).toContain("auto • low → qwen3.5-9b • low");
			expect(lines[2]).toContain("⚡ [Arbiter // Sandbox: git status]");
			expect(lines[2]).toContain(
				"\x1b[38;2;239;66;35m[Sys1: code // 85% conf, took 0.1s]\x1b[0m → \x1b[1mArtisan\x1b[0m (qwen3.5-9b) • low",
			);
		});

		it("footer lines strictly respect terminal width across narrow and wide screens", () => {
			const mockSession = {
				sessionManager: {
					getCwd: () => "/workspace/test/very/long/nested/path/to/project",
					getSessionName: () => "feature-heavy-deliberation",
					getEntryCount: () => 5,
					getSessionId: () => "s2",
					getLeafId: () => null,
					getEntries: () => [],
				},
				state: {
					model: { id: "deliberative", provider: "system2", reasoning: true },
					thinkingLevel: "high",
					track: "code",
					confidence: 0.94,
					tookMs: 450,
					deliberation: { status: "pass", summary: "Arbitrated consensus on Path 2" },
				},
				routedModel: {
					model: { id: "qwen-3.8-27b-intermediate@iq3_xxs", provider: "system2" },
					thinkingLevel: "high",
				},
				modelRuntime: { isUsingSubscription: () => false },
				getContextUsage: () => undefined,
				getActiveTool: () => ({
					toolName: "bash",
					summary: "pytest test/very/long/nested/test_suite.py --verbose",
					persona: "Arbiter // Sandbox",
				}),
			};
			const mockFooterData = {
				getGitBranch: () => "feature/nested-feature-branch",
				getAvailableProviderCount: () => 2,
				getExtensionStatuses: () => new Map(),
			};
			const footer = new FooterComponent(mockSession as any, mockFooterData as any);

			for (const width of [60, 80, 100, 120, 160]) {
				const rendered = footer.render(width);
				expect(rendered).toHaveLength(3);
				for (const line of rendered) {
					// Ensure no line visible width exceeds terminal width
					const { visibleWidth } = require("@earendil-works/pi-tui");
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});

		it("renders the Mondrian S2 logo and System2 wordmark", () => {
			const [top, bottom] = piLogoLines();
			expect(top).toContain(" S ");
			expect(top).toContain(" 2 ");
			expect(bottom).toContain("───");
			expect(piWordmark()).toContain("System");
			expect(piWordmark()).toContain("2");
		});
	});

	describe("upstream_update_decoupling", () => {
		it("sets system2 branding in package.json and config", () => {
			expect(APP_NAME).toBe("system2");
			expect(CONFIG_DIR_NAME).toBe(".pi");

			const pkgPath = resolve(__dirname, "../package.json");
			expect(existsSync(pkgPath)).toBe(true);
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			expect(pkg.piConfig?.name).toBe("system2");
			expect(pkg.piConfig?.configDir).toBe(".pi");
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

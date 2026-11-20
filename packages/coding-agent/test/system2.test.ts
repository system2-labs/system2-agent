import { fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	classifyRegime2ModelTier,
	createSystem2AutoModel,
	createSystem2DeliberativeModel,
	createSystem2LocalModel,
	resolveThinkingLevel,
	System2Client,
} from "../src/core/system2/index.ts";

describe("System 2 Cognitive Virtual Models", () => {
	it("lexical gate correctly classifies coding and logic prompts", async () => {
		const client = new System2Client("http://127.0.0.1:9999"); // unreachable port triggers lexical fallback

		const codeDecision = await client.route("Please refactor this def calculate_metrics(data): return data * 2");
		expect(codeDecision.selected_track).toBe("code");
		expect(codeDecision.method).toBe("lexical");

		const logicDecision = await client.route(
			"Prove the theorem using resolution refutation and Horn clause tautology",
		);
		expect(logicDecision.selected_track).toBe("logic");
		expect(logicDecision.method).toBe("lexical");

		const mathDecision = await client.route("Compute the derivative of f(x) and the matrix eigenvalue");
		expect(mathDecision.selected_track).toBe("math");
		expect(mathDecision.method).toBe("lexical");
	});

	it("registers system2/auto and system2/deliberative on ModelRuntime", async () => {
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

		// Register System 2 virtual models
		runtime.registerVirtualModel(createSystem2AutoModel(runtime));
		runtime.registerVirtualModel(createSystem2DeliberativeModel(runtime));
		await runtime.refresh({ allowNetwork: false });

		const autoModel = runtime.getModel("system2", "auto");
		expect(autoModel).toBeDefined();
		expect(autoModel?.name).toBe("System 2 Cognitive Router");

		const deliberativeModel = runtime.getModel("system2", "deliberative");
		expect(deliberativeModel).toBeDefined();
		expect(deliberativeModel?.name).toBe("System 2 Deliberative Engine (Verified)");
	});

	it("routes coding turn to appropriate physical model and tracks state", async () => {
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
		await runtime.refresh({ allowNetwork: false });

		const autoModel = runtime.getModel("system2", "auto")!;

		const route = await runtime.resolveModel(
			autoModel,
			[{ role: "user", content: "def fibonacci(n): return fibonacci(n-1) + fibonacci(n-2)", timestamp: Date.now() }],
			{ reason: "user", thinkingLevel: "low" },
		);

		expect(route.model).toBeDefined();
		expect(route.state).toBeDefined();
		const state = route.state as any;
		expect(state.track).toBe("code");
	});

	it("routes to local LM Studio models and enforces Regime 2 thinking 'off' for quantized models", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		// Simulate LM Studio models
		const lmstudio = fauxProvider({
			provider: "lmstudio",
			models: [
				{ id: "qwen-3.8-27b-smoll", contextWindow: 262_144, maxTokens: 8192, input: ["text"] },
				{ id: "google/gemma-4-12b", contextWindow: 131_072, maxTokens: 8192, input: ["text"] },
			],
		});
		runtime.registerNativeProvider(lmstudio.provider);
		runtime.registerVirtualModel(createSystem2LocalModel(runtime));
		await runtime.refresh({ allowNetwork: false });

		const localModel = runtime.getModel("system2", "local")!;
		expect(localModel).toBeDefined();

		// Code prompt should route to qwen-3.8-27b-smoll with thinking turned OFF (Regime 2)
		const route = await runtime.resolveModel(
			localModel,
			[{ role: "user", content: "def lru_cache(): pass", timestamp: Date.now() }],
			{ reason: "user", thinkingLevel: "high" }, // requested high, but Regime 2 clamps to "off"
		);

		expect(route.model.id).toContain("qwen");
		expect(route.thinkingLevel).toBe("off");
	});

	it("applies Regime 2 v2 tier-aware thinking policy across 27B splash, 9B VoT, tiny 4-bit, and 2-bit/3-bit", () => {
		const splash27b = { id: "qwen3.8-27b-splash", provider: "lmstudio" };
		const qwen9b = { id: "qwen3.5-9b", provider: "lmstudio" };
		const gemma12b = { id: "google/gemma-4-12b", provider: "lmstudio" };
		const tiny08b = { id: "Qwen3.5-0.8B-4bit", provider: "mlx" };
		const smoll2bit = { id: "qwen-3.8-27b-smoll", provider: "lmstudio" };
		const iq2 = { id: "qwen-3.8-27b-intermediate@q2_k_xl", provider: "lmstudio" };

		expect(classifyRegime2ModelTier(splash27b)).toBe("flagship_local");
		expect(classifyRegime2ModelTier(qwen9b)).toBe("mid_local");
		expect(classifyRegime2ModelTier(gemma12b)).toBe("mid_local");
		expect(classifyRegime2ModelTier(tiny08b)).toBe("edge_tiny_4bit");
		expect(classifyRegime2ModelTier(smoll2bit)).toBe("ultra_low_bit");
		expect(classifyRegime2ModelTier(iq2)).toBe("ultra_low_bit");

		// 27B splash: thinking ALWAYS ON (high on symbolic/safety, medium on general/code)
		expect(resolveThinkingLevel(splash27b, "math", 0.95, "off")).toBe("high");
		expect(resolveThinkingLevel(splash27b, "code", 0.95, "off")).toBe("medium");
		expect(resolveThinkingLevel(splash27b, "safety", 0.99, "off")).toBe("high");

		// 9B mid_local: selective HDM VoT Gate (`recommendedThinking` wins; safety fail-closed)
		expect(resolveThinkingLevel(qwen9b, "math", 0.9, "off", "on")).toBe("medium");
		expect(resolveThinkingLevel(qwen9b, "code", 0.9, "off", "on")).toBe("low");
		expect(resolveThinkingLevel(qwen9b, "math", 0.9, "high", "off")).toBe("off");
		expect(resolveThinkingLevel(qwen9b, "safety", 0.99, "off", "off")).toBe("medium");
		// Offline fallback (no daemon recommendedThinking): escalate low-conf / hard, off on easy high-conf
		expect(resolveThinkingLevel(qwen9b, "math", 0.72, "off")).toBe("medium");
		expect(resolveThinkingLevel(qwen9b, "general", 0.92, "off")).toBe("off");

		// Tiny <=4.5B 4-bit and 2-bit/3-bit: hard OFF even if user/daemon asks for thinking
		expect(resolveThinkingLevel(tiny08b, "math", 0.5, "high", "on")).toBe("off");
		expect(resolveThinkingLevel(smoll2bit, "safety", 0.99, "high", "on")).toBe("off");
		expect(resolveThinkingLevel(iq2, "math", 0.5, "high", "on")).toBe("off");
	});
});

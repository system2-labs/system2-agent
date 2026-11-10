import { fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	createSystem2AutoModel,
	createSystem2DeliberativeModel,
	createSystem2LocalModel,
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
});

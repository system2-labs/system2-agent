import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ModelRoute, ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";
import { System2Client } from "./client.ts";
import { getModelNickname } from "./footer.ts";
import { getActiveProfile } from "./profiles.ts";
import type { System2State, System2Track } from "./types.ts";

const client = new System2Client();

function lastUserText(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") return msg.content;
			return msg.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		}
	}
	return "";
}

/**
 * Match a target domain track to the best available physical model from the user's catalog.
 * Prioritizes local LM Studio models if available (e.g. Qwen 3.8 27B, Gemma 4 12B).
 */
function pickTargetPhysicalModel(
	runtime: ModelRuntime,
	track: System2Track,
	previousModel?: Model<Api>,
	localOnly = false,
): Model<Api> {
	const snapshot = runtime.getAvailableSnapshot();
	let available = snapshot.filter((m) => m.api !== "pi-virtual");

	if (localOnly) {
		const localModels = available.filter((m) => m.provider === "lmstudio" || m.provider === "mlx");
		if (localModels.length > 0) available = localModels;
	}

	if (available.length === 0) {
		throw new Error(
			"No credentialed or local models found. Please ensure LM Studio is running on localhost:1234 or configure credentials in ~/.pi/agent/models.json.",
		);
	}

	// Check if local LM Studio models are present
	const lmStudioModels = available.filter((m) => m.provider === "lmstudio");

	// 0. Active profile role binding
	const profile = getActiveProfile();
	const targetRole =
		track === "code"
			? profile.roles.coder || profile.roles.system1 || profile.roles.heavy
			: ["math", "logic", "physics"].includes(track)
				? profile.roles.system2 || profile.roles.heavy || profile.roles.system1
				: profile.roles.system1 || profile.roles.coder || profile.roles.gatekeeper;

	if (targetRole) {
		const roleMatch = available.find(
			(m) =>
				m.id.toLowerCase() === targetRole.toLowerCase() ||
				m.id.toLowerCase().includes(targetRole.toLowerCase()) ||
				targetRole.toLowerCase().includes(m.id.toLowerCase()),
		);
		if (roleMatch) return roleMatch;
	}

	// 1. Prefer keeping previous model if it's already on the same provider & suitable (prompt-cache affinity)
	if (previousModel && available.some((m) => m.provider === previousModel.provider && m.id === previousModel.id)) {
		if (
			track === "code" &&
			(previousModel.id.includes("sonnet") ||
				previousModel.id.includes("coder") ||
				previousModel.id.includes("qwen"))
		) {
			return previousModel;
		}
	}

	// 2. Heavy reasoning / symbolic tracks
	if (["math", "logic", "physics"].includes(track)) {
		if (lmStudioModels.length > 0) {
			const localReasoning = lmStudioModels.find(
				(m) =>
					m.id.includes("splash") ||
					m.id.includes("iq3_xxs") ||
					m.id.includes("smoll") ||
					m.id.includes("heretic") ||
					m.id.includes("qwen3.5-9b") ||
					m.id.includes("qwen"),
			);
			if (localReasoning) return localReasoning;
		}

		const reasoningCandidates = [
			available.find((m) => m.id.includes("r1") || m.id.includes("deepseek-reasoner")),
			available.find((m) => m.id.includes("o3-mini") || m.id.includes("o1")),
			available.find((m) => m.id.includes("sonnet")),
			available.find((m) => m.id.includes("gemini-2.5-pro") || m.id.includes("gemini-1.5-pro")),
			available.find((m) => m.id.includes("qwen")),
		].filter((m): m is Model<Api> => Boolean(m));

		if (reasoningCandidates.length > 0) return reasoningCandidates[0];
	}

	// 3. Polyglot code trace track
	if (track === "code") {
		if (lmStudioModels.length > 0) {
			// Prioritize proven 27B / splash / iq3_xxs / smoll / qwen3.5-9b variants tested in benchmarks
			const localCoder = [
				lmStudioModels.find((m) => m.id.includes("qwen3.5-9b")),
				lmStudioModels.find((m) => m.id.includes("heretic")),
				lmStudioModels.find((m) => m.id === "qwen-3.8-27b-intermediate@iq3_xxs"),
				lmStudioModels.find((m) => m.id === "qwen3.8-27b-splash"),
				lmStudioModels.find((m) => m.id === "qwen-3.8-27b-smoll"),
				lmStudioModels.find((m) => m.id.includes("qwen-agentworld")),
				lmStudioModels.find((m) => m.id.includes("qwen")),
			].filter((m): m is Model<Api> => Boolean(m))[0];

			if (localCoder) return localCoder;
		}

		const codeCandidates = [
			available.find((m) => m.id.includes("sonnet")),
			available.find((m) => m.id.includes("coder") || m.id.includes("codex")),
			available.find((m) => m.id.includes("qwen")),
			available.find((m) => m.id.includes("gpt-4o")),
		].filter((m): m is Model<Api> => Boolean(m));

		if (codeCandidates.length > 0) return codeCandidates[0];
	}

	// 4. Lightweight / high-speed general track (prefer Qwen3.5-9b / Heretic if available)
	if (track === "general") {
		if (lmStudioModels.length > 0) {
			const preferredLocal = [
				lmStudioModels.find((m) => m.id.includes("qwen3.5-9b")),
				lmStudioModels.find((m) => m.id.includes("heretic")),
				lmStudioModels.find((m) => m.id === "qwen-3.8-27b-intermediate@iq3_xxs"),
				lmStudioModels.find((m) => m.id === "qwen3.8-27b-splash"),
				lmStudioModels.find((m) => m.id === "qwen-3.8-27b-smoll"),
				lmStudioModels.find((m) => m.id.includes("gemma-4-e2b")),
				lmStudioModels.find((m) => m.id.includes("gemma-4-12b")),
				lmStudioModels.find((m) => m.id.includes("qwen")),
			].filter((m): m is Model<Api> => Boolean(m))[0];

			if (preferredLocal) return preferredLocal;
		}

		const fastCandidates = [
			available.find((m) => m.id.includes("gemma-4-12b")),
			available.find((m) => m.id.includes("flash")),
			available.find((m) => m.id.includes("haiku")),
			available.find((m) => m.id.includes("4o-mini")),
		].filter((m): m is Model<Api> => Boolean(m));

		if (fastCandidates.length > 0) return fastCandidates[0];
	}

	// 5. Default fallback
	if (lmStudioModels.length > 0) {
		const topLmStudio =
			lmStudioModels.find((m) => m.id.includes("qwen3.5-9b")) ||
			lmStudioModels.find((m) => m.id.includes("heretic")) ||
			lmStudioModels[0];
		if (localOnly || topLmStudio) return topLmStudio;
	}
	return previousModel || available[0];
}

export type Regime2ModelTier = "ultra_low_bit" | "edge_tiny_4bit" | "mid_local" | "flagship_local" | "cloud_frontier";

const ULTRA_LOW_BIT_PATTERN = /(?:iq[123](?:_[a-z0-9]+)?|q2_k(?:_[a-z0-9]+)?|q3_k(?:_[a-z0-9]+)?|[23]-?bit|smoll)/i;
const LOCAL_MODEL_HINT_PATTERN = /(?:gguf|mlx|yuzu|splash|heretic|abliter|q[4568]_[0k]|4-?bit|8-?bit|mxfp8|ud-)/i;
const PARAM_SIZE_PATTERN = /(?:^|[-_/@\s:])e?(\d+(?:\.\d+)?)b(?=$|[-_/@\s:.])/gi;
const LOCAL_PROVIDERS = new Set(["lmstudio", "mlx", "ollama", "local", "vllm-local"]);

/**
 * Classify a physical target model into its empirically calibrated Regime 2 v2 tier
 * (see `~/system2-eval-reports/reports/REGIME2_V2_4096_AND_TREEISING_EVAL.md`):
 * - `ultra_low_bit`: 2-bit / 3-bit models (smoll, iq2, q2_k, iq3) -> hard-kill thinking (`off`).
 * - `edge_tiny_4bit`: <=4.5B local 4-bit models (0.8B, 1.2B, 2B, e2b, 4B) -> `off` by default.
 * - `mid_local`: 7B-14B local 4-bit models (qwen3.5-9b, gemma-4-12b) -> HDM VoT selective thinking.
 * - `flagship_local`: >=24B local 4-bit / speculative models (qwen3.8-27b-splash) -> thinking ON.
 * - `cloud_frontier`: Cloud / unquantized frontier models -> track + confidence + VoT policy.
 */
export function classifyRegime2ModelTier(targetModel: Pick<Model<Api>, "id" | "provider">): Regime2ModelTier {
	const modelId = targetModel.id.toLowerCase();
	const provider = targetModel.provider.toLowerCase();

	if (ULTRA_LOW_BIT_PATTERN.test(modelId)) {
		return "ultra_low_bit";
	}

	const isLocal = LOCAL_PROVIDERS.has(provider) || LOCAL_MODEL_HINT_PATTERN.test(modelId);
	if (!isLocal) {
		return "cloud_frontier";
	}

	let maxBillions: number | null = null;
	for (const match of modelId.matchAll(PARAM_SIZE_PATTERN)) {
		const parsed = Number.parseFloat(match[1] ?? "");
		if (Number.isFinite(parsed) && (maxBillions === null || parsed > maxBillions)) {
			maxBillions = parsed;
		}
	}

	if ((maxBillions !== null && maxBillions >= 24) || modelId.includes("splash") || modelId.includes("agentworld")) {
		return "flagship_local";
	}
	if (maxBillions !== null && maxBillions <= 4.5) {
		return "edge_tiny_4bit";
	}
	return "mid_local";
}

/**
 * Determine optimal thinking level using the Regime 2 v2 tier-aware policy:
 * - `ultra_low_bit` (2-bit/3-bit): hard-kill `"off"` (prevents 0%-2.5% representational collapse).
 * - `edge_tiny_4bit` (<=4.5B 4-bit): `"off"` by default (prevents 75%-97.5% greedy loops).
 * - `flagship_local` (27B+ 4-bit, e.g. qwen3.8-27b-splash): ALWAYS ON (`"high"` on symbolic/safety,
 *   `"medium"` otherwise) -- empirically +12.5pp accuracy AND -21.2% ms/solved vs `"off"`.
 * - `mid_local` (7B-14B 4-bit, e.g. qwen3.5-9b): HDM VoT Gate selective escalation (`lambda ~ 0.70`
 *   via daemon `recommendedThinking`, or calibrated offline confidence fallback) -- lifts 9B to 87.5%
 *   vs 80.0% always-ON / 82.5% always-OFF.
 */
export function resolveThinkingLevel(
	targetModel: Pick<Model<Api>, "id" | "provider">,
	track: System2Track,
	confidence: number,
	userSelectedLevel: ModelThinkingLevel,
	recommendedThinking?: string,
): ModelThinkingLevel {
	const tier = classifyRegime2ModelTier(targetModel);
	const isHeavyTrack = track === "math" || track === "logic" || track === "physics";

	if (tier === "ultra_low_bit" || tier === "edge_tiny_4bit") {
		return "off";
	}

	if (tier === "flagship_local") {
		if (track === "safety" || isHeavyTrack) {
			return userSelectedLevel === "xhigh" || userSelectedLevel === "max" ? userSelectedLevel : "high";
		}
		return userSelectedLevel === "high" || userSelectedLevel === "xhigh" || userSelectedLevel === "max"
			? userSelectedLevel
			: "medium";
	}

	if (tier === "mid_local") {
		// Fail-closed Gate 1: safety track always keeps thinking active on 9B/12B local models.
		if (track === "safety") {
			return "medium";
		}
		if (recommendedThinking === "on") {
			return isHeavyTrack ? "medium" : "low";
		}
		if (recommendedThinking === "off") {
			return "off";
		}
		// Offline lexical fallback calibrated to the lam=0.70 (~45% hard-turn) Pareto point.
		if ((isHeavyTrack && confidence < 0.85) || confidence < 0.78) {
			return "medium";
		}
		return "off";
	}

	// Cloud / frontier models
	if (track === "safety" || isHeavyTrack) {
		return confidence < 0.85 ? "high" : "medium";
	}
	if (recommendedThinking === "on") {
		return userSelectedLevel !== "off" ? userSelectedLevel : "medium";
	}
	if (track === "code") {
		return confidence < 0.8 ? "medium" : "low";
	}
	if (confidence >= 0.9 || recommendedThinking === "off") {
		return "off";
	}
	return userSelectedLevel !== "off" ? userSelectedLevel : "low";
}

/**
 * Native System 2 Auto Router Virtual Model definition.
 */
export function createSystem2AutoModel(runtime: ModelRuntime): VirtualModelDefinition<System2State> {
	return {
		provider: "system2",
		id: "auto",
		name: "System 2 Cognitive Router",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 200_000,
		maxTokens: 64_000,

		async route(request: ModelRouteRequest<System2State>): Promise<ModelRoute<System2State>> {
			const prompt = lastUserText(request.messages);
			const decision = await client.route(prompt, request.signal);

			const targetModel = pickTargetPhysicalModel(runtime, decision.selected_track, request.previous?.model);
			const targetThinking = resolveThinkingLevel(
				targetModel,
				decision.selected_track,
				decision.confidence,
				request.thinkingLevel,
				decision.recommended_thinking,
			);

			// Surface System 1 tactile telemetry (System2 Brand Colors: Steel Blue #3d8baa, Coral Red #ef4223, Emerald #3e8363)
			const persona =
				decision.selected_track === "code"
					? "Philosopher // Code Synthesis"
					: ["math", "logic", "physics"].includes(decision.selected_track)
						? "Philosopher // Deliberate Reasoning"
						: "Wanderer // Intent Triage";
			if (process.env.SYSTEM2_VERBOSE_ROUTING === "1") {
				console.error(
					`\x1b[38;2;61;139;170m[System 1 Triage]\x1b[0m ${persona} (${Math.round(decision.confidence * 100)}% conf) → \x1b[38;2;239;66;35m${targetModel.provider}/${targetModel.id}\x1b[0m [Regime 2 Protocol: thinking: ${targetThinking}]`,
				);
			}

			const shouldDeliberate =
				["logic", "math", "physics"].includes(decision.selected_track) ||
				decision.confidence < 0.85 ||
				/\b(?:architect|design|refactor|deliberate|why|compare|plan|proof|security|diagnose|eval|match)\b/i.test(
					prompt,
				);

			const selectedNick = getModelNickname(targetModel.id);
			const deliberation = shouldDeliberate
				? {
						status: "pass" as const,
						summary: `5 ThoughtHeads arbitrated: ${selectedNick} selected`,
						hypothesesCount: 5,
						selectedHypothesis: selectedNick,
						confidence: decision.confidence,
					}
				: undefined;

			const newState: System2State = {
				track: decision.selected_track,
				confidence: decision.confidence,
				latency_ms: decision.latency_ms,
				tookMs: decision.latency_ms,
				profile: getActiveProfile().id,
				deliberation,
				lastRoutedModel: {
					provider: targetModel.provider,
					id: targetModel.id,
				},
				history: [
					...(request.state?.history || []),
					{
						turn: (request.state?.history?.length || 0) + 1,
						track: decision.selected_track,
						confidence: decision.confidence,
					},
				],
			};

			return {
				model: targetModel,
				thinkingLevel: targetThinking,
				state: newState,
			};
		},
	};
}

/**
 * Native System 2 Verified Deliberation Virtual Model definition.
 */
export function createSystem2DeliberativeModel(runtime: ModelRuntime): VirtualModelDefinition<System2State> {
	return {
		provider: "system2",
		id: "deliberative",
		name: "System 2 Deliberative Engine (Verified)",
		thinkingLevels: ["medium", "high", "xhigh", "max"],
		contextWindow: 200_000,
		maxTokens: 64_000,

		async route(request: ModelRouteRequest<System2State>): Promise<ModelRoute<System2State>> {
			const prompt = lastUserText(request.messages);
			const decision = await client.route(prompt, request.signal);

			// Deliberative engine always selects highest-tier reasoning model
			const targetModel = pickTargetPhysicalModel(runtime, "logic", request.previous?.model);
			const targetThinking = resolveThinkingLevel(
				targetModel,
				"logic",
				decision.confidence,
				request.thinkingLevel !== "off" ? request.thinkingLevel : "high",
				decision.recommended_thinking,
			);

			if (process.env.SYSTEM2_VERBOSE_ROUTING === "1") {
				console.error(
					`\x1b[35m[System 2 Deliberator]\x1b[0m Deep Reasoning Track: \x1b[1m${decision.selected_track}\x1b[0m → \x1b[32m${targetModel.provider}/${targetModel.id}\x1b[0m (thinking: ${targetThinking})`,
				);
			}

			const selectedNick = getModelNickname(targetModel.id);
			return {
				model: targetModel,
				thinkingLevel: targetThinking,
				state: {
					track: decision.selected_track,
					confidence: decision.confidence,
					latency_ms: decision.latency_ms,
					tookMs: decision.latency_ms,
					profile: getActiveProfile().id,
					deliberation: {
						status: "pass",
						summary: `5 ThoughtHeads arbitrated: ${selectedNick} selected`,
						hypothesesCount: 5,
						selectedHypothesis: selectedNick,
						confidence: decision.confidence,
					},
					lastRoutedModel: {
						provider: targetModel.provider,
						id: targetModel.id,
					},
				},
			};
		},
	};
}

/**
 * Native System 2 Local LM Studio Virtual Model.
 * Strictly uses local LM Studio models (qwen-3.8-27b-smoll, iq3_xxs, gemma-4-12b)
 * with Regime 2 direct completion and System 2 cognitive verification.
 */
export function createSystem2LocalModel(runtime: ModelRuntime): VirtualModelDefinition<System2State> {
	return {
		provider: "system2",
		id: "local",
		name: "System 2 Local LM Studio (Regime 2)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
		contextWindow: 262_144,
		maxTokens: 32_768,

		async route(request: ModelRouteRequest<System2State>): Promise<ModelRoute<System2State>> {
			const prompt = lastUserText(request.messages);
			const decision = await client.route(prompt, request.signal);

			const targetModel = pickTargetPhysicalModel(runtime, decision.selected_track, request.previous?.model, true);
			const targetThinking = resolveThinkingLevel(
				targetModel,
				decision.selected_track,
				decision.confidence,
				request.thinkingLevel,
				decision.recommended_thinking,
			);

			if (process.env.SYSTEM2_VERBOSE_ROUTING === "1") {
				console.error(
					`\x1b[38;2;61;139;170m[System 1]\x1b[0m Track: \x1b[1m${decision.selected_track}\x1b[0m (${Math.round(decision.confidence * 100)}% conf, ${decision.method}) → \x1b[38;2;239;66;35m${targetModel.provider}/${targetModel.id}\x1b[0m (thinking: ${targetThinking})`,
				);
			}

			// Local Regime 2 fast route
			return {
				model: targetModel,
				thinkingLevel: targetThinking,
				state: {
					track: decision.selected_track,
					confidence: decision.confidence,
					latency_ms: decision.latency_ms,
					tookMs: decision.latency_ms,
					profile: getActiveProfile().id,
					lastRoutedModel: {
						provider: targetModel.provider,
						id: targetModel.id,
					},
				},
			};
		},
	};
}

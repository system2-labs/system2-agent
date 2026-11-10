import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ModelRoute, ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";
import { System2Client } from "./client.ts";
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
 */
function pickTargetPhysicalModel(runtime: ModelRuntime, track: System2Track, previousModel?: Model<Api>): Model<Api> {
	const snapshot = runtime.getAvailableSnapshot();
	const available = snapshot.filter((m) => m.api !== "pi-virtual");

	if (available.length === 0) {
		// Fall back to any configured provider model
		const allModels = runtime.getModels().filter((m) => m.api !== "pi-virtual");
		if (allModels.length > 0) return allModels[0];
		throw new Error("No physical models with configured credentials found in Pi.");
	}

	// 1. Prefer keeping previous model if it's already on the same provider & suitable (prompt-cache affinity)
	if (previousModel && available.some((m) => m.provider === previousModel.provider && m.id === previousModel.id)) {
		if (track === "code" && (previousModel.id.includes("sonnet") || previousModel.id.includes("coder"))) {
			return previousModel;
		}
	}

	// 2. Heavy reasoning / symbolic tracks
	if (["math", "logic", "physics"].includes(track)) {
		const reasoningCandidates = [
			// DeepSeek R1
			available.find((m) => m.id.includes("r1") || m.id.includes("deepseek-reasoner")),
			// OpenAI o3-mini / o1
			available.find((m) => m.id.includes("o3-mini") || m.id.includes("o1")),
			// Claude 3.7 / 3.5 Sonnet
			available.find((m) => m.id.includes("sonnet")),
			// Gemini Pro
			available.find((m) => m.id.includes("gemini-2.5-pro") || m.id.includes("gemini-1.5-pro")),
		].filter((m): m is Model<Api> => Boolean(m));

		if (reasoningCandidates.length > 0) return reasoningCandidates[0];
	}

	// 3. Polyglot code trace track
	if (track === "code") {
		const codeCandidates = [
			available.find((m) => m.id.includes("sonnet")),
			available.find((m) => m.id.includes("coder") || m.id.includes("codex")),
			available.find((m) => m.id.includes("gpt-4o")),
		].filter((m): m is Model<Api> => Boolean(m));

		if (codeCandidates.length > 0) return codeCandidates[0];
	}

	// 4. Lightweight / high-speed general track
	if (track === "general") {
		const fastCandidates = [
			available.find((m) => m.id.includes("flash")),
			available.find((m) => m.id.includes("haiku")),
			available.find((m) => m.id.includes("4o-mini")),
		].filter((m): m is Model<Api> => Boolean(m));

		if (fastCandidates.length > 0) return fastCandidates[0];
	}

	// 5. Default fallback to previous model or first available
	return previousModel || available[0];
}

/**
 * Determine optimal thinking level based on track and calibrated confidence.
 */
function resolveThinkingLevel(
	track: System2Track,
	confidence: number,
	userSelectedLevel: ModelThinkingLevel,
): ModelThinkingLevel {
	if (["math", "logic", "physics"].includes(track)) {
		return confidence < 0.85 ? "high" : "medium";
	}
	if (track === "code") {
		return confidence < 0.8 ? "medium" : "low";
	}
	if (confidence >= 0.9) {
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
				decision.selected_track,
				decision.confidence,
				request.thinkingLevel,
			);

			const newState: System2State = {
				track: decision.selected_track,
				confidence: decision.confidence,
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
			const targetThinking = request.thinkingLevel !== "off" ? request.thinkingLevel : "high";

			return {
				model: targetModel,
				thinkingLevel: targetThinking,
				state: {
					track: decision.selected_track,
					confidence: decision.confidence,
					lastRoutedModel: {
						provider: targetModel.provider,
						id: targetModel.id,
					},
				},
			};
		},
	};
}

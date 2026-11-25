import { describe, expect, it } from "vitest";
import {
	buildArenaPolicyPromotion,
	compareChallengerAgainstIncumbent,
	detectSystemVramBudget,
	evaluatePersonaArena,
	evaluatePersonaChallenger,
	fingerprintChallengerModel,
	PERSONA_PROFILE_ROLE_MAP,
	parseLmsEstimateOutput,
	parseLmsPsAllocatedVramGb,
	planSafeLmStudioLoad,
	probeModelBehavioralQuirks,
	renderArenaScorecardMarkdown,
	runRosterChallengerArena,
} from "../src/core/system2/model-arena.ts";

describe("Phase 0: detectSystemVramBudget & planSafeLmStudioLoad (128GB M4 Max & LM Studio --auto/--estimate-only)", () => {
	it("detects 128GB Mac Metal wired VRAM ceiling (112.3 GiB), subtracts loaded lms ps models, and prevents 1M-ctx inkling-2-mini oversubscription", () => {
		const lmsPsSample = [
			"IDENTIFIER                         MODEL                              STATUS    SIZE        CONTEXT    PARALLEL",
			"qwen3.5-9b                         qwen3.5-9b                         IDLE      6.27 GB     32768      1",
		].join("\n");
		expect(parseLmsPsAllocatedVramGb(lmsPsSample)).toBe(6.27);
		expect(parseLmsPsAllocatedVramGb("No models are currently loaded.")).toBe(0);

		const budget = detectSystemVramBudget({
			totalMemoryBytes: 137438953472, // 128 GiB M4 Max
			metalWiredLimitMb: 115000, // 112.30 GiB Metal wired limit
			lmsPsOutput: lmsPsSample,
			safetyHeadroomRatio: 0.85,
		});
		expect(budget.totalSystemRamGb).toBe(128);
		expect(budget.metalWiredCeilingGb).toBe(112.3);
		expect(budget.alreadyAllocatedVramGb).toBe(6.27);
		expect(budget.availableVramGb).toBeGreaterThan(85);

		const est = parseLmsEstimateOutput(
			"Model: thinkingmachines/inkling-2-mini\nContext Length: 32,768\nEstimated GPU Memory:   19.15 GiB\nEstimated Total Memory: 19.15 GiB\nEstimate: This model may be loaded based on your resource guardrails settings.",
		);
		expect(est.contextLength).toBe(32768);
		expect(est.estimatedGpuMemoryGb).toBe(19.15);
		expect(est.loadableByGuardrails).toBe(true);

		const loadPlan = planSafeLmStudioLoad({
			modelId: "thinkingmachines/inkling-2-mini",
			requestedContextLength: 1048576,
			requestedParallel: 4,
			weightsGb: 16.0,
			vramBudget: budget,
			estimateByContext: {
				1048576: 73.81,
				65536: 22.4,
				32768: 19.15,
			},
		});
		expect(loadPlan.safeToLoad).toBe(true);
		expect(loadPlan.oversubscriptionPrevented).toBe(true);
		expect(loadPlan.selectedContextLength).toBeLessThanOrEqual(65536);
		expect(loadPlan.selectedParallel).toBe(1);
		expect(loadPlan.useAutoPlacement).toBe(true);
		expect(loadPlan.projectedPeakVramGb).toBeLessThanOrEqual(budget.availableVramGb);
		expect(loadPlan.recommendedMaxTokens).toBe(1536);
		expect(loadPlan.lmsLoadArgs).toContain("--auto");
		expect(loadPlan.lmsLoadArgs).toContain("--parallel");
		expect(loadPlan.lmsLoadArgs).toContain("1");
	});
});

describe("Phase 1: probeModelBehavioralQuirks / fingerprintChallengerModel", () => {
	it("detects low-bit CoT token-noise loop collapse and forces recommendedThinkingLevel to 'off'", () => {
		const inklingQuirks = fingerprintChallengerModel({
			modelId: "thinkingmachines/inkling-2-mini",
			parameterCountB: 2.4,
			quantizationBits: 4,
			vramGb: 1.8,
			samples: [
				{
					thinkingLevel: "medium",
					outputText: "<think>wait let me check wait let me check wait let me check wait let me check",
				},
				{
					thinkingLevel: "low",
					cotLoopDetected: true,
					toolJsonValid: true,
				},
				{
					thinkingLevel: "off",
					cotLoopDetected: false,
					toolJsonValid: true,
				},
			],
		});

		expect(inklingQuirks.regime2Tier).toBe("edge_tiny_4bit");
		expect(inklingQuirks.recommendedRegime2Tier).toBe("edge_tiny_4bit");
		expect(inklingQuirks.cotLoopCollapseRate).toBe(1);
		expect(inklingQuirks.cotCollapseRate).toBe(1);
		expect(inklingQuirks.recommendedThinkingLevel).toBe("off");
		expect(inklingQuirks.requiresLeanGuardAutoRepair).toBe(false);
		expect(inklingQuirks.requiresLeanGuardRepair).toBe(false);
		expect(inklingQuirks.notes[0]).toContain('force thinking="off"');
	});

	it("flags high malformed tool JSON rates for LeanGuard auto-repair and disqualifies over-censored models from Heretic", () => {
		const censoredQuirks = probeModelBehavioralQuirks({
			modelId: "safe-chat-7b-q3",
			parameterCountB: 7,
			quantizationBits: 3,
			samples: [
				{ thinkingLevel: "low", toolJsonValid: false, isBenignRedTeamPrompt: true, refusedPrompt: true },
				{
					thinkingLevel: "low",
					toolJsonValid: true,
					isBenignRedTeamPrompt: true,
					outputText: "I cannot assist with security probe generation.",
				},
			],
		});

		expect(censoredQuirks.regime2Tier).toBe("ultra_low_bit");
		expect(censoredQuirks.recommendedThinkingLevel).toBe("off");
		expect(censoredQuirks.requiresLeanGuardAutoRepair).toBe(true);
		expect(censoredQuirks.eligibleForHeretic).toBe(false);
		expect(censoredQuirks.benignRedTeamRefusalRate).toBe(1);
		expect(censoredQuirks.redTeamRefusalRate).toBe(1);
	});
});

describe("Phase 2: evaluatePersonaChallenger / compareChallengerAgainstIncumbent", () => {
	it("promotes thinkingmachines/inkling-2-mini over incumbent for Wanderer / Chief when Pareto dominant", () => {
		const quirkyInkling = probeModelBehavioralQuirks({
			modelId: "thinkingmachines/inkling-2-mini",
			parameterCountB: 2.4,
			quantizationBits: 4,
			cotLoopCollapseRate: 0.4,
			toolJsonMalformedRate: 0.02,
		});

		const verdict = compareChallengerAgainstIncumbent({
			persona: "Wanderer",
			incumbent: {
				modelId: "gemma-4-e2b-it-qat",
				accuracy: 0.84,
				firstPassVerifyRate: 0.82,
				p95LatencyMs: 420,
				vramGb: 2.6,
			},
			challenger: {
				modelId: "thinkingmachines/inkling-2-mini",
				accuracy: 0.89,
				firstPassVerifyRate: 0.88,
				p95LatencyMs: 260,
				vramGb: 1.8,
				quirkReport: quirkyInkling,
			},
			maxVramBudgetGb: 24,
		});

		expect(verdict.verdict).toBe("promote_challenger");
		expect(verdict.promote).toBe(true);
		expect(verdict.paretoDominant).toBe(true);
		expect(verdict.winningPersonas).toEqual(["Wanderer"]);
		expect(verdict.scoreDelta).toBeGreaterThan(0);
		expect(verdict.recommendedProfilePatch).toEqual({
			persona: "Wanderer",
			profileRoleKey: PERSONA_PROFILE_ROLE_MAP.Wanderer,
			modelId: "thinkingmachines/inkling-2-mini",
			recommendedThinkingLevel: "off",
			requiresLeanGuardAutoRepair: false,
			requiresLeanGuardRepair: false,
		});
	});

	it("disqualifies over-censored models from Heretic and non-vision models from Ocular", () => {
		const hereticVerdict = evaluatePersonaChallenger({
			persona: "Heretic",
			incumbent: {
				modelId: "deepseek-v4-pro-qwen3.5-9b-uncensored-heretic",
				accuracy: 0.88,
				firstPassVerifyRate: 0.85,
				p95LatencyMs: 650,
				vramGb: 6.5,
				benignRedTeamRefusalRate: 0.01,
			},
			challenger: {
				modelId: "over-aligned-coder-9b",
				accuracy: 0.94,
				firstPassVerifyRate: 0.92,
				p95LatencyMs: 500,
				vramGb: 6.0,
				benignRedTeamRefusalRate: 0.35,
			},
		});
		expect(hereticVerdict.verdict).toBe("disqualified_behavior_gate");
		expect(hereticVerdict.promote).toBe(false);
		expect(hereticVerdict.reasons[0]).toContain("benignRedTeamRefusalRate <= 0.05");

		const ocularVerdict = evaluatePersonaChallenger({
			persona: "Ocular",
			incumbent: {
				modelId: "qwen3-vl-4b-instruct",
				accuracy: 0.86,
				firstPassVerifyRate: 0.84,
				p95LatencyMs: 480,
				vramGb: 3.5,
				supportsVision: true,
			},
			challenger: {
				modelId: "thinkingmachines/inkling-2-mini",
				accuracy: 0.91,
				firstPassVerifyRate: 0.9,
				p95LatencyMs: 250,
				vramGb: 1.8,
				supportsVision: false,
			},
		});
		expect(ocularVerdict.verdict).toBe("disqualified_behavior_gate");
		expect(ocularVerdict.reasons[0]).toContain("supportsVision: true");
	});

	it("retains incumbent when challenger regresses accuracy or exceeds VRAM budget", () => {
		const keepVerdict = evaluatePersonaChallenger({
			persona: "Philosopher",
			incumbent: {
				modelId: "qwen3.8-27b-splash",
				accuracy: 0.95,
				firstPassVerifyRate: 0.93,
				p95LatencyMs: 1100,
				vramGb: 16,
			},
			challenger: {
				modelId: "thinkingmachines/inkling-2-mini",
				accuracy: 0.78,
				firstPassVerifyRate: 0.75,
				p95LatencyMs: 250,
				vramGb: 1.8,
			},
		});
		expect(keepVerdict.verdict).toBe("keep_incumbent");
		expect(keepVerdict.paretoDominant).toBe(false);
	});
});

describe("Phase 3: runRosterChallengerArena, evaluatePersonaArena & buildArenaPolicyPromotion", () => {
	it("evaluates challenger across multiple persona slots, builds policy promotion diff, and renders Markdown scorecard", () => {
		expect(runRosterChallengerArena).toBe(evaluatePersonaArena);
		const report = evaluatePersonaArena({
			runId: "arena-2026-11-25-inkling",
			maxVramBudgetGb: 24,
			slots: [
				{
					persona: "Chief",
					incumbent: {
						modelId: "gemma-4-e2b-it-qat",
						accuracy: 0.83,
						firstPassVerifyRate: 0.81,
						p95LatencyMs: 410,
						vramGb: 2.5,
					},
					challengers: [
						{
							modelId: "thinkingmachines/inkling-2-mini",
							accuracy: 0.88,
							firstPassVerifyRate: 0.87,
							p95LatencyMs: 240,
							vramGb: 1.8,
							cotLoopCollapseRate: 0.3,
						},
					],
				},
				{
					persona: "Ocular",
					incumbent: {
						modelId: "qwen3-vl-4b-instruct",
						accuracy: 0.87,
						firstPassVerifyRate: 0.85,
						p95LatencyMs: 500,
						vramGb: 3.4,
						supportsVision: true,
					},
					challengers: [
						{
							modelId: "thinkingmachines/inkling-2-mini",
							accuracy: 0.9,
							firstPassVerifyRate: 0.88,
							p95LatencyMs: 240,
							vramGb: 1.8,
							supportsVision: false,
						},
					],
				},
			],
		});

		expect(report.promote).toBe(true);
		expect(report.winningPersonas).toEqual(["Chief"]);
		expect(report.promotedSlots).toHaveLength(1);
		expect(report.disqualifiedCount).toBe(1);

		const promotion = buildArenaPolicyPromotion(report, "fast-coding");
		expect(promotion.baseProfileId).toBe("fast-coding");
		expect(promotion.promote).toBe(true);
		expect(promotion.promotedRoles).toEqual({ gatekeeper: "thinkingmachines/inkling-2-mini" });
		expect(promotion.routingOverrides[0].thinking).toBe("off");

		const md = renderArenaScorecardMarkdown(report);
		expect(md).toContain("# System 2 Challenger Arena Scorecard (arena-2026-11-25-inkling)");
		expect(md).toContain(
			"| Chief | `gemma-4-e2b-it-qat` | `thinkingmachines/inkling-2-mini` | `promote_challenger` |",
		);
		expect(md).toContain(
			"| Ocular | `qwen3-vl-4b-instruct` | `thinkingmachines/inkling-2-mini` | `disqualified_behavior_gate` |",
		);
	});
});

/**
 * System 2 Challenger Model Eval & 8-Persona Behavioral Arena (`S2-FAC-08`):
 * Phase 0: Hardware VRAM Auto-Detection & LM Studio Safe Load Planner (`detectSystemVramBudget`, `parseLmsEstimateOutput`, `planSafeLmStudioLoad`)
 * Phase 1: Regime 2 Behavioral Quirk Fingerprinter (`probeModelBehavioralQuirks`, `fingerprintChallengerModel`)
 * Phase 2: 8-Persona Role Arena & Pareto Evaluator (`evaluatePersonaChallenger`, `compareChallengerAgainstIncumbent`, `evaluatePersonaArena`)
 * Phase 3: Policy & Profile Auto-Promotion Proposal (`runRosterChallengerArena`, `buildArenaPolicyPromotion`, `renderArenaScorecardMarkdown`)
 */
import { totalmem } from "node:os";

export interface SystemVramBudgetOptions {
	totalMemoryBytes?: number;
	metalWiredLimitMb?: number;
	alreadyAllocatedVramGb?: number;
	lmsPsOutput?: string;
	safetyHeadroomRatio?: number;
}

export interface SystemVramBudget {
	totalSystemRamGb: number;
	metalWiredCeilingGb: number;
	alreadyAllocatedVramGb: number;
	safeMaxVramBudgetGb: number;
	availableVramGb: number;
}

export interface LmsEstimateResult {
	modelId?: string;
	contextLength?: number;
	estimatedGpuMemoryGb: number;
	estimatedTotalMemoryGb: number;
	loadableByGuardrails: boolean;
}

export interface SafeLmStudioLoadInput {
	modelId: string;
	requestedContextLength?: number;
	requestedParallel?: number;
	weightsGb?: number;
	isLoopedLayerArchitecture?: boolean;
	useLmsAutoFlag?: boolean;
	vramBudget?: SystemVramBudget;
	estimateByContext?: Readonly<Record<number, number>>;
}

export interface SafeLmStudioLoadPlan {
	modelId: string;
	safeToLoad: boolean;
	selectedContextLength: number;
	selectedParallel: number;
	useAutoPlacement: boolean;
	lmsEstimateGb: number;
	projectedPeakVramGb: number;
	availableVramGb: number;
	metalWiredCeilingGb: number;
	oversubscriptionPrevented: boolean;
	recommendedMaxTokens: number;
	lmsLoadArgs: string[];
	rationale: string;
}

export type ArenaPersona =
	| "Chief"
	| "Wanderer"
	| "Philosopher"
	| "Arbiter"
	| "Archivist"
	| "Ocular"
	| "Heretic"
	| "Splinter";

export type ArenaThinkingLevel = "off" | "low" | "medium" | "high";
export type QuantizationBits = 2 | 3 | 4 | 8 | 16;
export type Regime2Tier = "ultra_low_bit" | "edge_tiny_4bit" | "mid_local" | "flagship_local" | "cloud_frontier";

export interface BehavioralTrialSample {
	thinkingLevel?: ArenaThinkingLevel;
	outputText?: string;
	cotLoopDetected?: boolean;
	toolJsonValid?: boolean;
	isBenignRedTeamPrompt?: boolean;
	refusedPrompt?: boolean;
}

export interface ModelQuirkProbeInput {
	modelId: string;
	parameterCountB?: number;
	quantizationBits?: QuantizationBits | number;
	vramGb?: number;
	supportsVision?: boolean;
	isCloudModel?: boolean;
	samples?: readonly BehavioralTrialSample[];
	cotLoopCollapseRate?: number;
	cotCollapseRate?: number;
	toolJsonMalformedRate?: number;
	malformedToolJsonRate?: number;
	benignRedTeamRefusalRate?: number;
	redTeamRefusalRate?: number;
}

export interface BehavioralQuirkReport {
	modelId: string;
	quantizationBits: number;
	cotLoopCollapseRate: number;
	cotCollapseRate: number;
	toolJsonMalformedRate: number;
	malformedToolJsonRate: number;
	benignRedTeamRefusalRate: number;
	redTeamRefusalRate: number;
	recommendedThinkingLevel: ArenaThinkingLevel;
	regime2Tier: Regime2Tier;
	recommendedRegime2Tier: Regime2Tier;
	requiresLeanGuardAutoRepair: boolean;
	requiresLeanGuardRepair: boolean;
	eligibleForHeretic: boolean;
	supportsVision: boolean;
	notes: string[];
}

export type ChallengerQuirkProfile = BehavioralQuirkReport;

export interface PersonaTrialMetrics {
	modelId: string;
	accuracy?: number;
	passRate?: number;
	localizationAccuracy?: number;
	firstPassVerifyRate?: number;
	verifyPyPassAt1?: number;
	fiveThoughtHeadCalibration?: number;
	multimodalSpatialAccuracy?: number;
	falsificationProbeRate?: number;
	falsificationProbeDiscoveryRate?: number;
	benignRedTeamRefusalRate?: number;
	redTeamRefusalRate?: number;
	p95LatencyMs?: number;
	msPerSolved?: number;
	tokensPerSec?: number;
	vramGb: number;
	tokenCostUsd?: number;
	supportsVision?: boolean;
	cotLoopCollapseRate?: number;
	cotCollapseRate?: number;
	toolJsonMalformedRate?: number;
	malformedToolJsonRate?: number;
	quirkReport?: BehavioralQuirkReport;
}

export interface EvaluatePersonaChallengerInput {
	persona: ArenaPersona;
	incumbent: PersonaTrialMetrics;
	challenger: PersonaTrialMetrics;
	maxVramBudgetGb?: number;
	minScoreDelta?: number;
}

export interface RecommendedProfilePatch {
	persona: ArenaPersona;
	profileRoleKey: string;
	modelId: string;
	recommendedThinkingLevel: ArenaThinkingLevel;
	requiresLeanGuardAutoRepair: boolean;
	requiresLeanGuardRepair: boolean;
}

export interface PersonaArenaVerdict {
	persona: ArenaPersona;
	incumbentModelId: string;
	challengerModelId: string;
	verdict: "promote_challenger" | "keep_incumbent" | "disqualified_behavior_gate";
	promote: boolean;
	paretoDominant: boolean;
	incumbentScore: number;
	challengerScore: number;
	scoreDelta: number;
	winningPersonas: ArenaPersona[];
	recommendedProfilePatch: RecommendedProfilePatch;
	reasons: string[];
	scorecardMarkdown: string;
}

export interface RosterChallengerSlotInput {
	persona: ArenaPersona;
	incumbent: PersonaTrialMetrics;
	challengers?: readonly PersonaTrialMetrics[];
	challenger?: PersonaTrialMetrics;
}

export interface RosterArenaInput {
	runId?: string;
	maxVramBudgetGb?: number;
	slots: readonly RosterChallengerSlotInput[];
}

export interface RosterArenaReport {
	runId: string;
	maxVramBudgetGb?: number;
	promote: boolean;
	winningPersonas: ArenaPersona[];
	reasons: string[];
	scorecardMarkdown: string;
	verdicts: PersonaArenaVerdict[];
	promotedSlots: PersonaArenaVerdict[];
	retainedSlots: PersonaArenaVerdict[];
	disqualifiedCount: number;
	recommendedPatches: RecommendedProfilePatch[];
}

export interface ArenaPolicyPromotionProposal {
	baseProfileId: string;
	promote: boolean;
	winningPersonas: ArenaPersona[];
	promotedRoles: Record<string, string>;
	recommendedPatches: RecommendedProfilePatch[];
	routingOverrides: Array<{
		persona: ArenaPersona;
		profileRoleKey: string;
		modelId: string;
		thinking: ArenaThinkingLevel;
		leanGuardRepair: boolean;
	}>;
	scorecardMarkdown: string;
}

export const PERSONA_PROFILE_ROLE_MAP: Record<ArenaPersona, string> = {
	Chief: "gatekeeper",
	Wanderer: "system1",
	Philosopher: "system2",
	Arbiter: "sentinel",
	Archivist: "local",
	Ocular: "vision",
	Heretic: "redteam",
	Splinter: "pruner",
};

const REPETITIVE_LOOP_RE = /(\b\w+(?:\s+\w+){1,5}\b)(?:\s+\1){3,}/i;
const REFUSAL_PHRASE_RE = /\b(i cannot assist|i can't help with|as an ai|against my safety policy|unable to comply)\b/i;
const LOOPED_ARCH_RE = /\b(inkling|loop|recurrent)\b/i;
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Parses `lms ps` output to sum currently allocated GPU/VRAM (in GiB) across loaded LM Studio models. */
export function parseLmsPsAllocatedVramGb(lmsPsOutput: string): number {
	if (!lmsPsOutput || /no models are currently loaded/i.test(lmsPsOutput)) return 0;
	let totalGb = 0;
	for (const line of lmsPsOutput.split(/\r?\n/)) {
		if (/^\s*IDENTIFIER\b/i.test(line)) continue;
		const match = line.match(/(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)\b/i);
		if (match) {
			const val = Number.parseFloat(match[1]);
			const unit = match[2].toUpperCase();
			if (Number.isFinite(val)) {
				totalGb += unit.startsWith("M") ? val / 1024 : val;
			}
		}
	}
	return Number(totalGb.toFixed(2));
}

/** Parses `lms load <model> --estimate-only` output into structured VRAM numbers. */
export function parseLmsEstimateOutput(rawOutput: string): LmsEstimateResult {
	const modelMatch = rawOutput.match(/Model:\s*([^\r\n]+)/i);
	const ctxMatch = rawOutput.match(/Context Length:\s*([\d,]+)/i);
	const gpuMatch = rawOutput.match(/Estimated GPU Memory:\s*(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)/i);
	const totMatch = rawOutput.match(/Estimated Total Memory:\s*(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)/i);
	const toGb = (m: RegExpMatchArray | null): number => {
		if (!m) return 0;
		const v = Number.parseFloat(m[1]);
		return m[2].toUpperCase().startsWith("M") ? Number((v / 1024).toFixed(2)) : v;
	};
	const gpuGb = toGb(gpuMatch);
	const totGb = toGb(totMatch) || gpuGb;
	return {
		...(modelMatch ? { modelId: modelMatch[1].trim() } : {}),
		...(ctxMatch ? { contextLength: Number.parseInt(ctxMatch[1].replace(/,/g, ""), 10) } : {}),
		estimatedGpuMemoryGb: gpuGb,
		estimatedTotalMemoryGb: totGb,
		loadableByGuardrails: /may be loaded/i.test(rawOutput) && !/cannot be loaded|exceeds/i.test(rawOutput),
	};
}

/**
 * Phase 0a: Auto-detects host unified memory / Metal wired VRAM ceiling (e.g. 128 GB M4 Max -> 112.3 GiB Metal ceiling)
 * and subtracts already-loaded LM Studio models so the Arena never oversubscribes VRAM.
 */
export function detectSystemVramBudget(options: SystemVramBudgetOptions = {}): SystemVramBudget {
	const totalBytes = options.totalMemoryBytes ?? totalmem();
	const totalSystemRamGb = Number((totalBytes / 1024 ** 3).toFixed(2));
	const metalWiredCeilingGb =
		options.metalWiredLimitMb !== undefined && options.metalWiredLimitMb > 0
			? Number((options.metalWiredLimitMb / 1024).toFixed(2))
			: Number((totalSystemRamGb * 0.8773).toFixed(2));
	const alreadyAllocatedVramGb =
		options.alreadyAllocatedVramGb ??
		(options.lmsPsOutput !== undefined ? parseLmsPsAllocatedVramGb(options.lmsPsOutput) : 0);
	const headroomRatio = clamp01(options.safetyHeadroomRatio ?? 0.82);
	const safeMaxVramBudgetGb = Number((metalWiredCeilingGb * headroomRatio).toFixed(2));
	const availableVramGb = Number(Math.max(0, safeMaxVramBudgetGb - alreadyAllocatedVramGb).toFixed(2));
	return {
		totalSystemRamGb,
		metalWiredCeilingGb,
		alreadyAllocatedVramGb,
		safeMaxVramBudgetGb,
		availableVramGb,
	};
}

/**
 * Phase 0b: Computes a safe LM Studio load plan (`--auto`, `--context-length`, `--parallel 1`)
 * accounting for looped-layer Metal compute buffers (e.g. `inkling2_loop` 1M ctx + parallel=4 -> 152 GiB spike).
 */
export function planSafeLmStudioLoad(input: SafeLmStudioLoadInput): SafeLmStudioLoadPlan {
	const budget = input.vramBudget ?? detectSystemVramBudget();
	const isLooped = input.isLoopedLayerArchitecture ?? LOOPED_ARCH_RE.test(input.modelId);
	const weightsGb = input.weightsGb ?? 16.0;
	const reqCtx = input.requestedContextLength ?? 1048576;
	const reqParallel = input.requestedParallel ?? 4;
	const useAutoPlacement = input.useLmsAutoFlag ?? true;

	const projectPeakGb = (ctx: number, parallel: number): { lmsEst: number; peak: number } => {
		const explicitEst = input.estimateByContext?.[ctx];
		const kvGb = (ctx / 32768) * (isLooped ? 1.02 : 0.85);
		const baseComputeGb = (ctx / 32768) * (isLooped ? 2.05 : 0.9);
		const lmsEst = explicitEst ?? Number((weightsGb + kvGb + baseComputeGb).toFixed(2));
		const parallelComputeBurst =
			parallel > 1 || (isLooped && ctx > 65536) ? (ctx / 32768) * (isLooped ? 0.81 * parallel : 0.35 * parallel) : 0;
		const peak = Number((lmsEst + parallelComputeBurst).toFixed(2));
		return { lmsEst, peak };
	};

	const initialProj = projectPeakGb(reqCtx, reqParallel);
	const candidateContexts = [reqCtx, 65536, 32768, 16384, 8192].filter((c, i, a) => c <= reqCtx && a.indexOf(c) === i);
	let selectedCtx = 32768;
	let selectedParallel = 1;
	let chosenProj = projectPeakGb(32768, 1);
	let foundSafe = false;

	for (const ctx of candidateContexts) {
		const parallelToTry = ctx === reqCtx && reqParallel === 1 ? 1 : 1;
		const proj = projectPeakGb(ctx, parallelToTry);
		if (proj.peak <= budget.availableVramGb && (!isLooped || ctx <= 65536)) {
			selectedCtx = ctx;
			selectedParallel = parallelToTry;
			chosenProj = proj;
			foundSafe = true;
			break;
		}
	}

	if (!foundSafe) {
		selectedCtx = candidateContexts[candidateContexts.length - 1] ?? 8192;
		selectedParallel = 1;
		chosenProj = projectPeakGb(selectedCtx, 1);
		foundSafe = chosenProj.peak <= budget.availableVramGb;
	}

	const oversubscriptionPrevented =
		initialProj.peak > budget.metalWiredCeilingGb ||
		initialProj.peak > budget.availableVramGb ||
		selectedCtx < reqCtx ||
		selectedParallel < reqParallel;
	const recommendedMaxTokens = isLooped ? 1536 : 1024;
	const lmsLoadArgs = [
		"load",
		input.modelId,
		...(useAutoPlacement ? ["--auto"] : []),
		"--context-length",
		String(selectedCtx),
		"--parallel",
		String(selectedParallel),
		"-y",
	];

	return {
		modelId: input.modelId,
		safeToLoad: foundSafe,
		selectedContextLength: selectedCtx,
		selectedParallel,
		useAutoPlacement,
		lmsEstimateGb: chosenProj.lmsEst,
		projectedPeakVramGb: chosenProj.peak,
		availableVramGb: budget.availableVramGb,
		metalWiredCeilingGb: budget.metalWiredCeilingGb,
		oversubscriptionPrevented,
		recommendedMaxTokens,
		lmsLoadArgs,
		rationale: oversubscriptionPrevented
			? `Stepped down from ctx=${reqCtx}/parallel=${reqParallel} (projected ${initialProj.peak} GiB vs ${budget.metalWiredCeilingGb} GiB Metal ceiling) to safe ctx=${selectedCtx}/parallel=${selectedParallel} (${chosenProj.peak} GiB <= ${budget.availableVramGb} GiB available).`
			: `Fits within available VRAM (${chosenProj.peak} GiB <= ${budget.availableVramGb} GiB).`,
	};
}

function detectSampleLoop(sample: BehavioralTrialSample): boolean {
	if (sample.cotLoopDetected !== undefined) return sample.cotLoopDetected;
	const txt = sample.outputText ?? "";
	return REPETITIVE_LOOP_RE.test(txt) || (txt.includes("<think>") && !txt.includes("</think>") && txt.length > 240);
}

function classifyRegime2Tier(input: ModelQuirkProbeInput, quantBits: number): Regime2Tier {
	if (input.isCloudModel) return "cloud_frontier";
	const params = input.parameterCountB ?? 4;
	if (quantBits <= 3) return "ultra_low_bit";
	if (params <= 6 && quantBits <= 4) return "edge_tiny_4bit";
	if (params >= 24 && quantBits >= 4) return "flagship_local";
	return "mid_local";
}

/** Phase 1: Evaluates an open-weight challenger model for CoT loop collapse, malformed tool JSON, and red-team refusals. */
export function probeModelBehavioralQuirks(input: ModelQuirkProbeInput): BehavioralQuirkReport {
	const quantBits = input.quantizationBits ?? 4;
	const samples = input.samples ?? [];
	const thinkSamples = samples.filter((s) => (s.thinkingLevel ?? "low") !== "off");
	const loopPool = thinkSamples.length > 0 ? thinkSamples : samples;

	const computedLoopRate =
		loopPool.length > 0 ? loopPool.filter(detectSampleLoop).length / loopPool.length : quantBits <= 3 ? 0.35 : 0;
	const cotLoopCollapseRate = clamp01(input.cotLoopCollapseRate ?? input.cotCollapseRate ?? computedLoopRate);

	const jsonSamples = samples.filter((s) => s.toolJsonValid !== undefined);
	const computedJsonRate =
		jsonSamples.length > 0 ? jsonSamples.filter((s) => !s.toolJsonValid).length / jsonSamples.length : 0;
	const toolJsonMalformedRate = clamp01(
		input.toolJsonMalformedRate ?? input.malformedToolJsonRate ?? computedJsonRate,
	);

	const redSamples = samples.filter((s) => s.isBenignRedTeamPrompt);
	const computedRefusalRate =
		redSamples.length > 0
			? redSamples.filter((s) => s.refusedPrompt || REFUSAL_PHRASE_RE.test(s.outputText ?? "")).length /
				redSamples.length
			: 0;
	const benignRedTeamRefusalRate = clamp01(
		input.benignRedTeamRefusalRate ?? input.redTeamRefusalRate ?? computedRefusalRate,
	);

	const regime2Tier = classifyRegime2Tier(input, quantBits);
	let recommendedThinkingLevel: ArenaThinkingLevel = "low";
	if (cotLoopCollapseRate > 0.15 || regime2Tier === "ultra_low_bit" || regime2Tier === "edge_tiny_4bit") {
		recommendedThinkingLevel = "off";
	} else if (cotLoopCollapseRate <= 0.05 && (regime2Tier === "flagship_local" || regime2Tier === "cloud_frontier")) {
		recommendedThinkingLevel = "high";
	} else if (cotLoopCollapseRate <= 0.08) {
		recommendedThinkingLevel = "medium";
	}

	const requiresLeanGuardAutoRepair = toolJsonMalformedRate > 0.05;
	const eligibleForHeretic = benignRedTeamRefusalRate <= 0.05;
	const supportsVision = Boolean(input.supportsVision || /(-vl-|vision|ocular|omni)/i.test(input.modelId));
	const notes: string[] = [];
	if (recommendedThinkingLevel === "off") {
		notes.push(
			`Regime 2 override: force thinking="off" (cotLoopCollapseRate=${cotLoopCollapseRate.toFixed(2)}, tier=${regime2Tier})`,
		);
	}
	if (requiresLeanGuardAutoRepair) {
		notes.push(`Enable LeanGuard JSON auto-repair (toolJsonMalformedRate=${toolJsonMalformedRate.toFixed(2)})`);
	}
	if (!eligibleForHeretic) {
		notes.push(
			`Disqualified from Heretic role (benignRedTeamRefusalRate=${benignRedTeamRefusalRate.toFixed(2)} > 0.05)`,
		);
	}

	return {
		modelId: input.modelId,
		quantizationBits: quantBits,
		cotLoopCollapseRate,
		cotCollapseRate: cotLoopCollapseRate,
		toolJsonMalformedRate,
		malformedToolJsonRate: toolJsonMalformedRate,
		benignRedTeamRefusalRate,
		redTeamRefusalRate: benignRedTeamRefusalRate,
		recommendedThinkingLevel,
		regime2Tier,
		recommendedRegime2Tier: regime2Tier,
		requiresLeanGuardAutoRepair,
		requiresLeanGuardRepair: requiresLeanGuardAutoRepair,
		eligibleForHeretic,
		supportsVision,
		notes,
	};
}

/** Alias for `probeModelBehavioralQuirks` for Phase 1 quirk fingerprinting. */
export const fingerprintChallengerModel = probeModelBehavioralQuirks;

function resolvePrimaryAccuracy(m: PersonaTrialMetrics): number {
	return clamp01(
		m.accuracy ??
			m.passRate ??
			m.localizationAccuracy ??
			m.verifyPyPassAt1 ??
			m.multimodalSpatialAccuracy ??
			m.firstPassVerifyRate ??
			0,
	);
}

function resolveVerifyRate(m: PersonaTrialMetrics): number {
	return clamp01(
		m.firstPassVerifyRate ?? m.verifyPyPassAt1 ?? m.fiveThoughtHeadCalibration ?? resolvePrimaryAccuracy(m),
	);
}

function resolveLatencyMs(m: PersonaTrialMetrics): number {
	if (m.p95LatencyMs !== undefined) return Math.max(0, m.p95LatencyMs);
	if (m.msPerSolved !== undefined) return Math.max(0, m.msPerSolved);
	if (m.tokensPerSec && m.tokensPerSec > 0) return Math.round(25000 / m.tokensPerSec);
	return 500;
}

function computePersonaScore(persona: ArenaPersona, m: PersonaTrialMetrics): number {
	const acc = resolvePrimaryAccuracy(m);
	const fpv = resolveVerifyRate(m);
	const lat = 1 / (1 + resolveLatencyMs(m) / 1000);
	const vram = 1 / (1 + Math.max(0, m.vramGb) / 16);
	const cost = 1 / (1 + Math.max(0, m.tokenCostUsd ?? 0) * 10);
	if (persona === "Wanderer" || persona === "Chief" || persona === "Archivist" || persona === "Splinter") {
		return 0.28 * acc + 0.28 * fpv + 0.24 * lat + 0.15 * vram + 0.05 * cost;
	}
	if (persona === "Philosopher" || persona === "Arbiter") {
		const calib = clamp01(m.fiveThoughtHeadCalibration ?? fpv);
		return 0.4 * acc + 0.35 * fpv + 0.15 * calib + 0.05 * lat + 0.05 * vram;
	}
	if (persona === "Heretic") {
		const probe = clamp01(m.falsificationProbeRate ?? m.falsificationProbeDiscoveryRate ?? acc);
		return 0.35 * acc + 0.3 * fpv + 0.25 * probe + 0.1 * lat;
	}
	const spatial = clamp01(m.multimodalSpatialAccuracy ?? acc);
	return 0.4 * spatial + 0.35 * fpv + 0.15 * lat + 0.1 * vram;
}

/** Phase 2: Benchmarks a challenger model against an incumbent for a specific `system2-labs` persona slot. */
export function evaluatePersonaChallenger(input: EvaluatePersonaChallengerInput): PersonaArenaVerdict {
	const { persona, incumbent, challenger } = input;
	const maxVramBudgetGb = input.maxVramBudgetGb ?? detectSystemVramBudget().availableVramGb;
	const minDelta = input.minScoreDelta ?? 0.005;
	const incumbentScore = Number(computePersonaScore(persona, incumbent).toFixed(4));
	const challengerScore = Number(computePersonaScore(persona, challenger).toFixed(4));
	const scoreDelta = Number((challengerScore - incumbentScore).toFixed(4));

	const quirk =
		challenger.quirkReport ??
		probeModelBehavioralQuirks({
			modelId: challenger.modelId,
			vramGb: challenger.vramGb,
			supportsVision: challenger.supportsVision ?? challenger.multimodalSpatialAccuracy !== undefined,
			cotLoopCollapseRate: challenger.cotLoopCollapseRate ?? challenger.cotCollapseRate,
			toolJsonMalformedRate: challenger.toolJsonMalformedRate ?? challenger.malformedToolJsonRate,
			benignRedTeamRefusalRate: challenger.benignRedTeamRefusalRate ?? challenger.redTeamRefusalRate,
		});

	const reasons: string[] = [];
	let disqualified = false;
	if (maxVramBudgetGb !== undefined && challenger.vramGb > maxVramBudgetGb) {
		disqualified = true;
		reasons.push(`Challenger VRAM (${challenger.vramGb} GB) exceeds budget (${maxVramBudgetGb} GB)`);
	}
	if (persona === "Ocular" && !quirk.supportsVision) {
		disqualified = true;
		reasons.push("Ocular persona requires multimodal vision capability (supportsVision: true)");
	}
	if (persona === "Heretic" && !quirk.eligibleForHeretic) {
		disqualified = true;
		reasons.push(
			`Heretic persona requires benignRedTeamRefusalRate <= 0.05 (got ${quirk.benignRedTeamRefusalRate.toFixed(2)})`,
		);
	}

	const incAcc = resolvePrimaryAccuracy(incumbent);
	const chalAcc = resolvePrimaryAccuracy(challenger);
	const incFpv = resolveVerifyRate(incumbent);
	const chalFpv = resolveVerifyRate(challenger);
	const incLat = resolveLatencyMs(incumbent);
	const chalLat = resolveLatencyMs(challenger);

	const noQualityRegression = chalAcc >= incAcc - 0.01 && chalFpv >= incFpv - 0.01;
	const strictImprovement =
		chalAcc > incAcc || chalFpv > incFpv || chalLat < incLat || challenger.vramGb < incumbent.vramGb;
	const paretoDominant = !disqualified && noQualityRegression && strictImprovement && scoreDelta >= minDelta;

	const verdict: PersonaArenaVerdict["verdict"] = disqualified
		? "disqualified_behavior_gate"
		: paretoDominant
			? "promote_challenger"
			: "keep_incumbent";
	const promote = verdict === "promote_challenger";

	if (!disqualified) {
		reasons.push(
			promote
				? `Promoted ${challenger.modelId} over ${incumbent.modelId} (scoreDelta=+${scoreDelta.toFixed(4)}, thinking=${quirk.recommendedThinkingLevel})`
				: `Retained incumbent ${incumbent.modelId} (scoreDelta=${scoreDelta.toFixed(4)})`,
		);
	}

	const recommendedProfilePatch: RecommendedProfilePatch = {
		persona,
		profileRoleKey: PERSONA_PROFILE_ROLE_MAP[persona],
		modelId: promote ? challenger.modelId : incumbent.modelId,
		recommendedThinkingLevel: quirk.recommendedThinkingLevel,
		requiresLeanGuardAutoRepair: quirk.requiresLeanGuardAutoRepair,
		requiresLeanGuardRepair: quirk.requiresLeanGuardAutoRepair,
	};

	const scorecardMarkdown = `| ${persona} | \`${incumbent.modelId}\` | \`${challenger.modelId}\` | \`${verdict}\` | ${scoreDelta >= 0 ? `+${scoreDelta.toFixed(4)}` : scoreDelta.toFixed(4)} | \`${quirk.recommendedThinkingLevel}\` |`;

	return {
		persona,
		incumbentModelId: incumbent.modelId,
		challengerModelId: challenger.modelId,
		verdict,
		promote,
		paretoDominant,
		incumbentScore,
		challengerScore,
		scoreDelta,
		winningPersonas: promote ? [persona] : [],
		recommendedProfilePatch,
		reasons,
		scorecardMarkdown,
	};
}

/** Alias for `evaluatePersonaChallenger` comparing a challenger against an incumbent on a persona slot. */
export const compareChallengerAgainstIncumbent = evaluatePersonaChallenger;

/** Phase 3b: Renders a deterministic Markdown scorecard compatible with `~/system2-eval-reports/reports/`. */
export function renderArenaScorecardMarkdown(report: {
	runId: string;
	maxVramBudgetGb?: number;
	verdicts: readonly PersonaArenaVerdict[];
	promotedSlots: readonly PersonaArenaVerdict[];
	retainedSlots: readonly PersonaArenaVerdict[];
}): string {
	const lines: string[] = [
		`# System 2 Challenger Arena Scorecard (${report.runId})`,
		"",
		`- **VRAM Budget**: ${report.maxVramBudgetGb !== undefined ? `${report.maxVramBudgetGb} GB` : "unbounded"}`,
		`- **Promoted Challengers**: ${report.promotedSlots.length}`,
		`- **Retained Incumbents**: ${report.retainedSlots.length}`,
		"",
		"| Persona | Incumbent | Challenger | Verdict | Score Delta | Thinking |",
		"| --- | --- | --- | --- | --- | --- |",
		...report.verdicts.map((v) => v.scorecardMarkdown),
	];
	return lines.join("\n");
}

/** Phase 3a: Runs a multi-slot challenger arena across the 8-persona roster and collects Pareto promotions. */
export function runRosterChallengerArena(input: RosterArenaInput): RosterArenaReport {
	const runId = input.runId ?? "arena-run-default";
	const effectiveVramBudgetGb = input.maxVramBudgetGb ?? detectSystemVramBudget().availableVramGb;
	const verdicts: PersonaArenaVerdict[] = [];
	let disqualifiedCount = 0;

	for (const slot of input.slots) {
		const candidateList = slot.challengers ?? (slot.challenger ? [slot.challenger] : []);
		let bestVerdict: PersonaArenaVerdict | undefined;
		for (const challenger of candidateList) {
			const v = evaluatePersonaChallenger({
				persona: slot.persona,
				incumbent: slot.incumbent,
				challenger,
				maxVramBudgetGb: effectiveVramBudgetGb,
			});
			if (v.verdict === "disqualified_behavior_gate") disqualifiedCount++;
			if (!bestVerdict || (v.promote && (!bestVerdict.promote || v.challengerScore > bestVerdict.challengerScore))) {
				bestVerdict = v;
			}
		}
		if (bestVerdict) verdicts.push(bestVerdict);
	}

	const promotedSlots = verdicts.filter((v) => v.promote);
	const retainedSlots = verdicts.filter((v) => !v.promote);
	const recommendedPatches = promotedSlots.map((v) => v.recommendedProfilePatch);
	const winningPersonas = promotedSlots.map((v) => v.persona);
	const reasons = verdicts.flatMap((v) => v.reasons);
	const scorecardMarkdown = renderArenaScorecardMarkdown({
		runId,
		maxVramBudgetGb: effectiveVramBudgetGb,
		verdicts,
		promotedSlots,
		retainedSlots,
	});

	return {
		runId,
		maxVramBudgetGb: effectiveVramBudgetGb,
		promote: promotedSlots.length > 0,
		winningPersonas,
		reasons,
		scorecardMarkdown,
		verdicts,
		promotedSlots,
		retainedSlots,
		disqualifiedCount,
		recommendedPatches,
	};
}

/** Alias for `runRosterChallengerArena` evaluating challenger(s) across the 8-persona arena. */
export const evaluatePersonaArena = runRosterChallengerArena;

/** Phase 3c: Generates an immutable promotion proposal for `profiles.ts` and `EvolvablePolicy` routing rules. */
export function buildArenaPolicyPromotion(
	report: RosterArenaReport,
	baseProfileId = "fast-coding",
): ArenaPolicyPromotionProposal {
	const promotedRoles: Record<string, string> = {};
	const routingOverrides = report.recommendedPatches.map((patch) => {
		promotedRoles[patch.profileRoleKey] = patch.modelId;
		return {
			persona: patch.persona,
			profileRoleKey: patch.profileRoleKey,
			modelId: patch.modelId,
			thinking: patch.recommendedThinkingLevel,
			leanGuardRepair: patch.requiresLeanGuardAutoRepair,
		};
	});

	return {
		baseProfileId,
		promote: report.promote,
		winningPersonas: report.winningPersonas,
		promotedRoles,
		recommendedPatches: report.recommendedPatches,
		routingOverrides,
		scorecardMarkdown: report.scorecardMarkdown,
	};
}

export interface ModelProfile {
	id: string;
	name: string;
	description: string;
	recommendedVramGb: number;
	roles: Record<string, string>;
}

export const BUILTIN_PROFILES: Record<string, ModelProfile> = {
	"cybersec-redteam": {
		id: "cybersec-redteam",
		name: "Cybersec Red Team",
		description: "Adversarial security analysis, penetration testing, and vulnerability research",
		recommendedVramGb: 24,
		roles: {
			system1: "deepseek-v4-pro-qwen3.5-9b-uncensored-heretic",
			system2: "Huihui-Qwen3.8-27B-abliterated",
			sentinel: "lfm3-2b-omni-abliter8",
		},
	},
	"fast-coding": {
		id: "fast-coding",
		name: "Fast Coding",
		description: "Low-latency daily driver for interactive coding sessions",
		recommendedVramGb: 24,
		roles: {
			system1: "qwen-3.8-27b-intermediate@iq3_xxs",
			gatekeeper: "gemma-4-e2b-it-qat",
			sentinel: "lfm2.5-1.2b-instruct",
			heavy: "qwen3.8-27b-splash",
		},
	},
	"multimodal-vision": {
		id: "multimodal-vision",
		name: "Multimodal Vision",
		description: "Multimodal vision-centric reasoning with lightweight coding backbones",
		recommendedVramGb: 18,
		roles: {
			vision: "qwen3-vl-4b-instruct",
			coder: "qwen-3.8-27b-intermediate@q2_k_xl",
			sentinel: "lfm2.5-1.2b-instruct",
		},
	},
	"big-brain-hybrid": {
		id: "big-brain-hybrid",
		name: "Big Brain Hybrid",
		description: "High-capacity hybrid profile for complex reasoning and large codebases",
		recommendedVramGb: 128,
		roles: {
			local: "qwen3.8-27b-splash",
			remote: "qwen3.8-flash-next",
			sentinel: "lfm2.5-1.2b-instruct",
		},
	},
	"lean-battery": {
		id: "lean-battery",
		name: "Lean Battery",
		description: "Battery-saving ultra-lightweight profile for mobile workflows",
		recommendedVramGb: 10,
		roles: {
			gatekeeper: "gemma-4-e2b-it-qat",
			coder: "qwen3.5-9b",
			sentinel: "lfm2.5-1.2b-instruct",
		},
	},
};

let activeProfileId = "fast-coding";

export const PROFILE_ALIASES: Record<string, string> = {
	"coding-swe": "fast-coding",
	"reasoning-heavy": "big-brain-hybrid",
	"sentinel-strict": "fast-coding",
	"edge-minimal": "lean-battery",
};

export function getAvailableProfiles(): ModelProfile[] {
	return Object.values(BUILTIN_PROFILES);
}

export function getActiveProfile(): ModelProfile {
	return BUILTIN_PROFILES[activeProfileId] ?? BUILTIN_PROFILES["fast-coding"];
}

export function setActiveProfile(id: string): ModelProfile {
	const normalized = PROFILE_ALIASES[id.toLowerCase()] || id.toLowerCase();
	activeProfileId = normalized in BUILTIN_PROFILES ? normalized : "fast-coding";
	return getActiveProfile();
}

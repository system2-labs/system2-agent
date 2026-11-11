import { createHash } from "node:crypto";

export interface EvolvablePolicy {
	version: number;
	checksum: string;
	prompts: Record<string, string>;
	routing: Record<string, { minConfidence: number; preferredModel?: string; keywords?: string[] }>;
	tools: Record<string, { description: string; handlerSnippet?: string; enabled: boolean }>;
}

export const IMMUTABLE_KERNEL_DOMAINS = [
	"checkpoint",
	"rollback",
	"verifier",
	"invariants",
	"agent-session-core",
	"process-runner",
] as const;

export type ImmutableKernelDomain = (typeof IMMUTABLE_KERNEL_DOMAINS)[number];
export const IMMUTABLE_KERNEL_PATHS = IMMUTABLE_KERNEL_DOMAINS;
export const IMMUTABLE_COMPONENTS = IMMUTABLE_KERNEL_DOMAINS;
export const PROTECTED_CORE_TOOLS = ["bash", "write_file", "edit"] as const;

const PROMPT_INJECTIONS = [
	/bypass.*verifier/i,
	/disable.*verifier/i,
	/bypass.*invariant/i,
	/disable.*invariant/i,
	/ignore.*verification/i,
	/skip.*verifier/i,
	/disable.*safety/i,
	/override.*invariant/i,
];

export class PolicyBoundaryViolation extends Error {
	readonly violations: string[];
	constructor(message: string, violations: string[] = []) {
		super(message);
		this.name = "PolicyBoundaryViolation";
		this.violations = violations.length ? violations : [message];
	}
}

export function deterministicStringify(obj: unknown): string {
	if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(deterministicStringify).join(",")}]`;
	const keys = Object.keys(obj as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${deterministicStringify((obj as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function computePolicyChecksum(policy: Omit<EvolvablePolicy, "checksum">): string {
	const payload = { prompts: policy.prompts, routing: policy.routing, tools: policy.tools, version: policy.version };
	return createHash("sha256").update(deterministicStringify(payload)).digest("hex");
}

export function createDefaultPolicy(): EvolvablePolicy {
	const prompts = {
		general: "Autonomous assistant using System 2 deliberation.",
		code: "Software engineer applying rigorous verification.",
		science: "Scientific reasoning expert using formal verification.",
	};
	const routing: EvolvablePolicy["routing"] = {
		general: { minConfidence: 0.0, keywords: [] },
		code: { minConfidence: 0.5, keywords: ["code", "refactor", "bug", "test"] },
		science: { minConfidence: 0.5, keywords: ["science", "hypothesis", "physics"] },
	};
	const tools = {};
	const version = 1;
	const checksum = computePolicyChecksum({ version, prompts, routing, tools });
	return Object.freeze({
		version,
		checksum,
		prompts: Object.freeze(prompts),
		routing: Object.freeze(routing),
		tools: Object.freeze(tools),
	});
}

export function validatePolicyMutation(
	_current: EvolvablePolicy,
	mutation: any,
): { valid: boolean; violations: string[] } {
	const violations: string[] = [];
	if (!mutation || typeof mutation !== "object") return { valid: false, violations: ["Mutation must be an object"] };

	for (const domain of IMMUTABLE_KERNEL_DOMAINS) {
		if (domain in mutation) violations.push(`Cannot mutate immutable kernel domain: '${domain}'`);
	}
	for (const key of [mutation.target, mutation.domain]) {
		if (key && (IMMUTABLE_KERNEL_DOMAINS.includes(key) || key === "invariant guards")) {
			violations.push(`Target '${key}' is an immutable kernel domain`);
		}
	}
	if ("invariant-guards" in mutation || "invariant guards" in mutation) {
		violations.push("Cannot mutate immutable kernel domain: 'invariant guards'");
	}

	if (mutation.tools && typeof mutation.tools === "object") {
		for (const tool of Object.keys(mutation.tools)) {
			if ((PROTECTED_CORE_TOOLS as readonly string[]).includes(tool)) {
				violations.push(`Cannot shadow protected core tool '${tool}'`);
			}
			if ((IMMUTABLE_KERNEL_DOMAINS as readonly string[]).includes(tool)) {
				violations.push(`Cannot register tool for immutable kernel domain '${tool}'`);
			}
		}
	}

	if (mutation.prompts && typeof mutation.prompts === "object") {
		for (const [key, text] of Object.entries(mutation.prompts)) {
			if ((IMMUTABLE_KERNEL_DOMAINS as readonly string[]).includes(key)) {
				violations.push(`Cannot mutate prompt for immutable kernel domain '${key}'`);
			}
			if (typeof text === "string" && PROMPT_INJECTIONS.some((p) => p.test(text))) {
				violations.push(`Prompt injection detected in prompt '${key}': attempt to bypass verification`);
			}
		}
	}

	if (mutation.routing && typeof mutation.routing === "object") {
		for (const key of Object.keys(mutation.routing)) {
			if ((IMMUTABLE_KERNEL_DOMAINS as readonly string[]).includes(key)) {
				violations.push(`Cannot mutate routing for immutable kernel domain '${key}'`);
			}
		}
	}

	return { valid: violations.length === 0, violations };
}

export function applyPolicyMutation(current: EvolvablePolicy, mutation: any): EvolvablePolicy {
	const res = validatePolicyMutation(current, mutation);
	if (!res.valid) {
		throw new PolicyBoundaryViolation(`Policy mutation rejected: ${res.violations.join("; ")}`, res.violations);
	}
	const version = (current.version ?? 0) + 1;
	const prompts = { ...current.prompts, ...(mutation.prompts || {}) };
	const routing = { ...current.routing, ...(mutation.routing || {}) };
	const tools = { ...current.tools, ...(mutation.tools || {}) };
	const checksum = computePolicyChecksum({ version, prompts, routing, tools });
	return Object.freeze({
		version,
		checksum,
		prompts: Object.freeze(prompts),
		routing: Object.freeze(routing),
		tools: Object.freeze(tools),
	});
}

export function resolvePolicyPrompt(policy: EvolvablePolicy, track: string, defaultPrompt?: string): string {
	return policy.prompts?.[track] ?? defaultPrompt ?? policy.prompts?.general ?? "";
}

export function resolvePolicyRoute(
	policy: EvolvablePolicy,
	track: string,
): { minConfidence: number; preferredModel?: string; keywords: string[] } {
	const route = policy.routing?.[track] ?? policy.routing?.general;
	return {
		minConfidence: route?.minConfidence ?? 0.5,
		preferredModel: route?.preferredModel,
		keywords: route?.keywords ? [...route.keywords] : [],
	};
}

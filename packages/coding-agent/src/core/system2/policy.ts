import { createHash } from "node:crypto";
import type { TaskGuardPolicy } from "./types.ts";

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
	"scope-lock",
	"diff-budget",
] as const;

export type ImmutableKernelDomain = (typeof IMMUTABLE_KERNEL_DOMAINS)[number];
export const IMMUTABLE_KERNEL_PATHS = IMMUTABLE_KERNEL_DOMAINS;
export const IMMUTABLE_COMPONENTS = IMMUTABLE_KERNEL_DOMAINS;
export const PROTECTED_CORE_TOOLS = ["bash", "write", "write_file", "edit"] as const;

const GUARD_BOUNDARY_ALIASES = [
	"invariant-guards",
	"invariant guards",
	"scopeLock",
	"diffBudget",
	"scope lock",
	"diff budget",
	"scope_lock",
	"diff_budget",
] as const;

const IMMUTABLE_DOMAIN_SET = new Set<string>(
	[...IMMUTABLE_KERNEL_DOMAINS, ...GUARD_BOUNDARY_ALIASES].map((d) => d.toLowerCase()),
);

function isImmutableDomain(value: unknown): value is string {
	return typeof value === "string" && IMMUTABLE_DOMAIN_SET.has(value.trim().toLowerCase());
}

const PROMPT_INJECTIONS = [
	/bypass.*verifier/i,
	/disable.*verifier/i,
	/bypass.*invariant/i,
	/disable.*invariant/i,
	/ignore.*verification/i,
	/skip.*verifier/i,
	/disable.*safety/i,
	/override.*invariant/i,
	/bypass.*scope[\s_-]*lock/i,
	/disable.*scope[\s_-]*lock/i,
	/override.*scope[\s_-]*lock/i,
	/ignore.*scope[\s_-]*lock/i,
	/bypass.*diff[\s_-]*budget/i,
	/disable.*diff[\s_-]*budget/i,
	/override.*diff[\s_-]*budget/i,
	/ignore.*diff[\s_-]*budget/i,
	/weaken.*(?:scope|budget|guard)/i,
	/(?:bypass|disable|override|ignore|skip|turn\s+off|remove|relax|lift|drop|weaken).*?(?:verifier|invariant|verification|safety|scope[\s_-]*lock|diff[\s_-]*budget|task[\s_-]*scope)/i,
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

	for (const key of Object.keys(mutation)) {
		if (isImmutableDomain(key)) {
			violations.push(`Cannot mutate immutable kernel domain: '${key}'`);
		}
	}
	for (const key of [mutation.target, mutation.domain]) {
		if (isImmutableDomain(key)) {
			violations.push(`Target '${key}' is an immutable kernel domain`);
		}
	}

	if (mutation.tools && typeof mutation.tools === "object") {
		for (const [tool, def] of Object.entries(mutation.tools)) {
			if ((PROTECTED_CORE_TOOLS as readonly string[]).includes(tool.trim().toLowerCase())) {
				violations.push(`Cannot shadow protected core tool '${tool}'`);
			}
			if (isImmutableDomain(tool)) {
				violations.push(`Cannot register tool for immutable kernel domain '${tool}'`);
			}
			if (def && typeof def === "object") {
				const toolDef = def as { description?: unknown; handlerSnippet?: unknown };
				for (const field of [toolDef.description, toolDef.handlerSnippet]) {
					if (typeof field === "string" && PROMPT_INJECTIONS.some((p) => p.test(field))) {
						violations.push(`Prompt injection detected in tool '${tool}': attempt to bypass verification`);
					}
				}
			}
		}
	}

	if (mutation.prompts && typeof mutation.prompts === "object") {
		for (const [key, text] of Object.entries(mutation.prompts)) {
			if (isImmutableDomain(key)) {
				violations.push(`Cannot mutate prompt for immutable kernel domain '${key}'`);
			}
			if (typeof text === "string" && PROMPT_INJECTIONS.some((p) => p.test(text))) {
				violations.push(`Prompt injection detected in prompt '${key}': attempt to bypass verification`);
			}
		}
	}

	if (mutation.routing && typeof mutation.routing === "object") {
		for (const key of Object.keys(mutation.routing)) {
			if (isImmutableDomain(key)) {
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

export function validateTaskGuardPolicy(policy: TaskGuardPolicy): { valid: boolean; violations: string[] } {
	const violations: string[] = [];
	if (!policy || typeof policy !== "object") {
		return { valid: false, violations: ["TaskGuardPolicy must be an object"] };
	}

	if (policy.scopeLock !== undefined) {
		const { allowedPaths, cwd } = policy.scopeLock;
		if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
			violations.push("scopeLock.allowedPaths must be a non-empty array");
		} else {
			for (let i = 0; i < allowedPaths.length; i++) {
				const entry = allowedPaths[i];
				if (typeof entry !== "string" || entry.trim().length === 0 || entry.includes("\0")) {
					violations.push(`scopeLock.allowedPaths[${i}] must be a non-empty string without null bytes`);
				}
			}
		}
		if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim().length === 0 || cwd.includes("\0"))) {
			violations.push("scopeLock.cwd must be a non-empty string without null bytes");
		}
	}

	if (policy.diffBudget !== undefined) {
		const { maxAddedLines, maxChangedLines, maxFiles } = policy.diffBudget;
		const checks: [string, number | undefined][] = [
			["maxAddedLines", maxAddedLines],
			["maxChangedLines", maxChangedLines],
			["maxFiles", maxFiles],
		];
		for (const [name, value] of checks) {
			if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
				violations.push(`diffBudget.${name} must be a non-negative finite number`);
			}
		}
	}

	return { valid: violations.length === 0, violations };
}

export function createTaskGuardPolicy(policy: TaskGuardPolicy): TaskGuardPolicy {
	const res = validateTaskGuardPolicy(policy);
	if (!res.valid) {
		throw new PolicyBoundaryViolation(`Invalid TaskGuardPolicy: ${res.violations.join("; ")}`, res.violations);
	}
	return Object.freeze({
		...(policy.scopeLock
			? {
					scopeLock: Object.freeze({
						...policy.scopeLock,
						allowedPaths: Object.freeze([...policy.scopeLock.allowedPaths]),
					}),
				}
			: {}),
		...(policy.diffBudget
			? {
					diffBudget: Object.freeze({ ...policy.diffBudget }),
				}
			: {}),
	});
}

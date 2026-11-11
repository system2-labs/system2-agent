/**
 * System 2 Cognitive Architecture types for Pi.
 */

export type System2Track =
	| "science"
	| "code"
	| "med"
	| "electrical"
	| "auto"
	| "culinary"
	| "math"
	| "legal"
	| "finance"
	| "physics"
	| "safety"
	| "eval"
	| "logic"
	| "general";

export interface System2Config {
	bridgeUrl?: string;
	allowOfflineBypass?: boolean;
}

export type InvariantDomain = "syntax" | "filesystem" | "command_safety" | "semantic";

export interface InvariantViolation {
	domain: InvariantDomain;
	rule: string;
	target?: string;
	explanation: string;
}

export interface ToolVerificationResult {
	allowed: boolean;
	decision?: "allow" | "block";
	reason?: string;
	code?: string;
	violations?: InvariantViolation[];
}

export interface System2RouteDecision {
	selected_track: System2Track;
	confidence: number;
	method: "lexical" | "centroid" | "fallback";
	latency_ms: number;
	recommended_model?: string;
	recommended_thinking?: string;
}

export interface System2State {
	track: System2Track;
	confidence: number;
	lastRoutedModel?: {
		provider: string;
		id: string;
	};
	history?: {
		turn: number;
		track: System2Track;
		confidence: number;
	}[];
}

export interface System2VerifyRequest {
	code_or_expression: string;
	domain: "units" | "algebra" | "logic" | "safety";
}

export interface System2VerifyResult {
	valid: boolean;
	code?: string;
	reason?: string;
	error?: string;
	details?: string;
}

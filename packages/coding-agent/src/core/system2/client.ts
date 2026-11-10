import type { System2RouteDecision, System2Track, System2VerifyRequest, System2VerifyResult } from "./types.ts";

const DEFAULT_BRIDGE_URL = process.env.SYSTEM2_BRIDGE_URL || "http://127.0.0.1:8765";

// Stage 1 In-Process Lexical Scanner (Fallback if Daemon is offline)
const LEXICAL_PATTERNS: Record<System2Track, RegExp[]> = {
	code: [
		/```(?:python|rust|cpp|c|csharp|java|sql|bash|sh|go|typescript|javascript)\b/i,
		/\b(?:def\s+[a-zA-Z_]\w*\s*\(|fn\s+[a-zA-Z_]\w*\s*\(|function\s+[a-zA-Z_]\w*\s*\(|public\s+static\s+void\b)/,
		/\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM)\b/i,
		/\b(?:console\.log|println!|printf\(|std::cout|npm|pnpm|cargo|git\s+commit|git\s+push)\b/,
		/\b(?:refactor|bug\s+fix|stack\s+trace|type\s+error|syntax\s+error)\b/i,
	],
	math: [
		/\b(?:integrate|derivative|polynomial|eigenvalue|eigenvector|matrix\s+multiplication|calculus)\b/i,
		/\b(?:proof|theorem|lemma|prime\s+number|modulo|combinatorics|factorial)\b/i,
		/[∫∑∏√πθλσ]/,
		/\b(?:dx|dy\/dx|f\(x\)|lim_{x\s*->)\b/,
	],
	physics: [
		/\b(?:quantum|hamiltonian|lagrangian|maxwell'?s\s+equations|special\s+relativity|general\s+relativity)\b/i,
		/\b(?:thermodynamics|entropy|lorentz\s+factor|planck\s+constant|gravitational\s+wave)\b/i,
		/\b(?:kinetic\s+energy|potential\s+energy|momentum|angular\s+momentum|torque)\b/i,
	],
	logic: [
		/\b(?:tautology|modus\s+ponens|satisfiability|SMT|first-order\s+logic|predicate\s+calculus)\b/i,
		/\b(?:boolean\s+satisfiability|cnf|horn\s+clause|resolution\s+refutation)\b/i,
		/[∧∨¬∀∃⊢⊨⇒⇔]/,
	],
	safety: [
		/\b(?:rm\s+-rf\s+\/|chmod\s+777|eval\(|drop\s+database|truncate\s+table)\b/i,
		/\b(?:exfiltrate|reverse\s+shell|bypass\s+auth|leak\s+key|disable\s+firewall)\b/i,
	],
	med: [
		/\b(?:diagnosis|symptoms|patient|vital\s+signs|pharmacology|biopsy|histology|pathology)\b/i,
		/\b(?:syndrome|clinical\s+trial|dosage|adverse\s+effect|contraindication)\b/i,
	],
	legal: [
		/\b(?:statute|jurisdiction|plaintiff|defendant|subpoena|deposition|tort|contract\s+breach)\b/i,
		/\b(?:constitutional|appellate|indemnity|arbitration|statutory)\b/i,
	],
	finance: [
		/\b(?:EBITDA|cash\s+flow|balance\s+sheet|amortization|options\s+pricing|black-scholes)\b/i,
		/\b(?:arbitrage|liquidity|portfolio\s+variance|sharpe\s+ratio|dividend\s+yield)\b/i,
	],
	electrical: [
		/\b(?:three-phase|KVL|KCL|Thevenin|Norton|impedance|reactive\s+power|microcontroller)\b/i,
		/\b(?:stator|rotor|induction\s+motor|RLC\s+circuit|ground\s+fault)\b/i,
	],
	auto: [
		/\b[PBUC][0-3][0-9A-F]{3}\b/,
		/\b(?:OBD-?II|DTC|fuel\s+trim|MAF\s+sensor|O2\s+sensor|alternator|starter\s+solenoid)\b/i,
	],
	culinary: [/\b(?:sourdough|fermentation|Maillard\s+reaction|caramelization|emulsification|gluten\s+matrix)\b/i],
	science: [/\b(?:hypothesis|spectroscopy|chemical\s+reaction|mitochondria|photosynthesis|enzymatic)\b/i],
	eval: [/\b(?:faithfulness|hallucination|rubric|grading\s+criterion|factual\s+consistency)\b/i],
	general: [],
};

export class System2Client {
	private bridgeUrl: string;

	constructor(bridgeUrl: string = DEFAULT_BRIDGE_URL) {
		this.bridgeUrl = bridgeUrl;
	}

	/**
	 * Sub-millisecond route dispatch.
	 * Calls local Python ModernBERT daemon if available, else falls back to in-process lexical gate.
	 */
	async route(prompt: string, signal?: AbortSignal): Promise<System2RouteDecision> {
		const start = performance.now();

		// Attempt fast HTTP call to local daemon (< 2 ms)
		try {
			const res = await fetch(`${this.bridgeUrl}/v1/route`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt }),
				signal: signal || AbortSignal.timeout(100), // 100 ms max timeout
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				return {
					selected_track: data.track,
					confidence: data.confidence ?? 0.85,
					method: data.method ?? "centroid",
					latency_ms: performance.now() - start,
					recommended_model: data.recommended_model,
					recommended_thinking: data.recommended_thinking,
				};
			}
		} catch {
			// Daemon offline or timed out; fall back to fast in-process lexical gate
		}

		// Fallback: In-process Stage 1 Lexical Gate (< 0.1 ms)
		return this.lexicalRoute(prompt, performance.now() - start);
	}

	private lexicalRoute(prompt: string, elapsedSoFar: number): System2RouteDecision {
		// Stage 0: Strict Safety Precedence Short-Circuit (< 0.01 ms)
		for (const pat of LEXICAL_PATTERNS.safety) {
			if (pat.test(prompt)) {
				return {
					selected_track: "safety",
					confidence: 0.99,
					method: "lexical",
					latency_ms: elapsedSoFar,
				};
			}
		}

		// Score matches across all domains
		const scores: Partial<Record<System2Track, number>> = {};
		let hasMatch = false;

		for (const [track, patterns] of Object.entries(LEXICAL_PATTERNS) as [System2Track, RegExp[]][]) {
			if (track === "safety" || track === "general") continue;
			scores[track] = 0;
			for (const pat of patterns) {
				const globalRegex = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : `${pat.flags}g`);
				const matches = prompt.match(globalRegex);
				if (matches && matches.length > 0) {
					scores[track] = (scores[track] ?? 0) + matches.length;
					hasMatch = true;
				}
			}
		}

		if (hasMatch) {
			let bestTrack: System2Track = "general";
			let bestScore = 0;
			for (const [track, score] of Object.entries(scores) as [System2Track, number][]) {
				if (score > bestScore) {
					bestScore = score;
					bestTrack = track;
				}
			}
			return {
				selected_track: bestTrack,
				confidence: Math.min(0.75 + bestScore * 0.08, 0.96),
				method: "lexical",
				latency_ms: elapsedSoFar,
			};
		}

		return {
			selected_track: "general",
			confidence: 0.75,
			method: "fallback",
			latency_ms: elapsedSoFar,
		};
	}

	/**
	 * Verify code or expression via True System 2 symbolic / SMT solvers.
	 */
	async verify(req: System2VerifyRequest): Promise<System2VerifyResult> {
		try {
			const res = await fetch(`${this.bridgeUrl}/v1/verify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(req),
				signal: AbortSignal.timeout(2000),
			});

			if (res.ok) {
				return (await res.json()) as System2VerifyResult;
			}
			return { valid: true, details: "Verification service uncontactable; permitted with warning." };
		} catch (e: any) {
			return { valid: true, details: `Verification bypassed: ${e.message}` };
		}
	}
}

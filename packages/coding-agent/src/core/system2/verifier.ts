import { System2Client } from "./client.ts";

const client = new System2Client();

export interface ToolVerificationResult {
	allowed: boolean;
	reason?: string;
}

/**
 * Deterministic System 2 pre-execution verification for dangerous or symbolic tool calls.
 */
export async function verifyToolCall(
	toolName: string,
	params: Record<string, any> | undefined,
): Promise<ToolVerificationResult> {
	if (!params) return { allowed: true };

	// 1. Safety Audit for Terminal Executions
	if (toolName === "bash" || toolName === "terminal" || toolName === "run_command") {
		const command = String(params.command || params.cmd || "");
		if (!command) return { allowed: true };

		// Fast client verification
		const audit = await client.verify({
			code_or_expression: command,
			domain: "safety",
		});

		if (!audit.valid) {
			return {
				allowed: false,
				reason: audit.error || "Command blocked by System 2 Safety Gatekeeper.",
			};
		}
	}

	// 2. Code write verification
	if (toolName === "write" || toolName === "edit" || toolName === "write_file") {
		const content = String(params.content || params.code || "");
		if (content.includes("verify_units") || content.includes("pint.")) {
			const audit = await client.verify({
				code_or_expression: content,
				domain: "units",
			});
			if (!audit.valid) {
				return {
					allowed: false,
					reason: `System 2 Dimensional Invariant Violation: ${audit.error}`,
				};
			}
		}
	}

	return { allowed: true };
}

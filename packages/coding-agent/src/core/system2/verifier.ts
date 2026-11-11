import { existsSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { System2Client } from "./client.ts";
import type { InvariantViolation, ToolVerificationResult } from "./types.ts";

export type { ToolVerificationResult };

// Silence experimental warning for built-in TypeScript syntax validation
const origEmit = process.emitWarning;
process.emitWarning = (w: any, ...a: any[]) =>
	(typeof w === "string" && w.includes("stripTypeScriptTypes")) ||
	(typeof a[0] === "string" && a[0].includes("stripTypeScriptTypes"))
		? undefined
		: (origEmit as any).call(process, w, ...a);

const DANGEROUS: [RegExp, string, string][] = [
	[/(?::\(\)\s*\{|:\s*\(\)\s*\{)[^}]*:[^}]*\|[^}]*:[^}]*&[^}]*\};:/, "no_fork_bomb", "Fork bomb detected"],
	[
		/\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(?:--no-preserve-root\s+)?(?:\/\*?|~(?:\/\*)?|\$(?:\{HOME\}|HOME)(?:\/\*)?)(?:\s|$|;)/,
		"no_destructive_rm",
		"Destructive rm -rf root/home detected",
	],
	[
		/\b(?:nc(?:\.traditional)?|ncat)\s+.*-e\s+|\/dev\/tcp\/|\bbash\s+-i\s+>&|\bexec\s+\d+<>\s*\/dev\/tcp/,
		"no_reverse_shell",
		"Reverse shell detected",
	],
	[
		/\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b|\bdd\s+.*of=\/dev\/(?:sd[a-z]|nvme|hd[a-z]|disk[0-9]|rdisk[0-9])|>\s*\/dev\/(?:sd[a-z]|nvme|hd[a-z]|disk[0-9]|rdisk[0-9])/,
		"no_destructive_disk",
		"Destructive disk operation detected",
	],
];

function block(code: string, violation: InvariantViolation): ToolVerificationResult {
	return { allowed: false, decision: "block", code, reason: violation.explanation, violations: [violation] };
}

export function checkCommandSafety(cmd: string): InvariantViolation | null {
	for (const [p, rule, explanation] of DANGEROUS)
		if (p.test(cmd)) return { domain: "command_safety", rule, explanation };
	return null;
}

export function checkSyntax(content: string, filePath: string): string | null {
	try {
		if (filePath.endsWith(".json")) JSON.parse(content);
		else if (/\.[mc]?[jt]sx?$/i.test(filePath)) stripTypeScriptTypes(content);
		return null;
	} catch (err: any) {
		return err?.message || String(err);
	}
}

const defaultClient = new System2Client();

export async function verifyToolCall(
	toolName: string,
	params: Record<string, any> | undefined,
	client: System2Client = defaultClient,
): Promise<ToolVerificationResult> {
	if (!params) return { allowed: true, decision: "allow" };

	if (["bash", "terminal", "run_command"].includes(toolName)) {
		const cmd = String(params.command || params.cmd || "");
		if (!cmd) return { allowed: true, decision: "allow" };
		const violation = checkCommandSafety(cmd);
		if (violation) return block("COMMAND_SAFETY_VIOLATION", violation);
		if (params.requireDaemonVerification) {
			const audit = await client.verify({ code_or_expression: cmd, domain: "safety" });
			if (!audit.valid)
				return block(audit.code || "SAFETY_AUDIT_FAILED", {
					domain: "command_safety",
					rule: "daemon_safety_check",
					explanation: audit.error || audit.reason || "Daemon verification failed.",
				});
		}
	}

	if (["write", "edit", "write_file"].includes(toolName)) {
		const filePath = String(params.path || params.filePath || params.file_path || "");
		let content = params.content ?? params.code ?? params.newText;
		if (content === undefined && filePath && existsSync(filePath) && Array.isArray(params.edits)) {
			content = params.edits.reduce(
				(acc: string, e: any) => (e.oldText && e.newText !== undefined ? acc.replace(e.oldText, e.newText) : acc),
				readFileSync(filePath, "utf-8"),
			);
		}
		if (content !== undefined && filePath) {
			const err = checkSyntax(String(content), filePath);
			if (err) {
				const isJson = filePath.endsWith(".json");
				return block(isJson ? "SYNTAX_ERROR_JSON" : "SYNTAX_ERROR", {
					domain: "syntax",
					rule: isJson ? "json_syntax" : "language_syntax",
					target: filePath,
					explanation: `Syntax error in ${filePath}: ${err}`,
				});
			}
		}
		const str = String(content ?? "");
		if (str.includes("verify_units") || str.includes("pint.")) {
			const audit = await client.verify({ code_or_expression: str, domain: "units" });
			if (!audit.valid)
				return block(audit.code || "DIMENSIONAL_INVARIANT_VIOLATION", {
					domain: "semantic",
					rule: "dimensional_invariants",
					target: filePath,
					explanation: `System 2 Dimensional Invariant Violation: ${audit.error || audit.reason}`,
				});
		}
	}

	return { allowed: true, decision: "allow" };
}

export interface PostExecutionOptions {
	allowEmpty?: boolean;
	expectedLineDelta?: number;
	previousLineCount?: number;
}

export async function verifyPostExecution(
	toolName: string,
	params: Record<string, any> | undefined,
	options?: PostExecutionOptions,
): Promise<ToolVerificationResult> {
	if (!params || !["write", "edit", "write_file"].includes(toolName)) return { allowed: true, decision: "allow" };
	const p = String(params.path || params.filePath || params.file_path || "");
	if (!p) return { allowed: true, decision: "allow" };
	if (!existsSync(p))
		return block("FILE_NOT_FOUND", {
			domain: "filesystem",
			rule: "file_exists",
			target: p,
			explanation: `File ${p} does not exist.`,
		});

	const stat = statSync(p);
	const allowEmpty = Boolean(
		options?.allowEmpty || params.allowEmpty || (toolName === "write" && params.content === ""),
	);
	if (stat.size === 0 && !allowEmpty)
		return block("FILE_TRUNCATED_OR_EMPTY", {
			domain: "filesystem",
			rule: "file_non_empty",
			target: p,
			explanation: `File ${p} is empty (0 bytes).`,
		});

	if (options?.expectedLineDelta !== undefined && options?.previousLineCount !== undefined) {
		const raw = readFileSync(p, "utf-8");
		const lines = (raw.endsWith("\n") ? raw.slice(0, -1) : raw)
			? (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n").length
			: 0;
		const expected = options.previousLineCount + options.expectedLineDelta;
		if (lines !== expected)
			return block("LINE_DELTA_MISMATCH", {
				domain: "filesystem",
				rule: "line_delta_match",
				target: p,
				explanation: `Line count mismatch: expected ${expected}, got ${lines}.`,
			});
	}
	return { allowed: true, decision: "allow" };
}

export async function verifyFileMutation(
	filePath: string,
	options?: PostExecutionOptions,
): Promise<ToolVerificationResult> {
	return verifyPostExecution("write", { path: filePath }, options);
}

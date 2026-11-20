import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { System2Client } from "./client.ts";
import { attemptArgumentRepair } from "./repair.ts";
import type {
	DiffBudget,
	InvariantViolation,
	TaskGuardPolicy,
	TaskScopeLock,
	ToolVerificationResult,
} from "./types.ts";

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

export interface VerifyToolOptions {
	guardPolicy?: TaskGuardPolicy;
	budgetTracker?: DiffBudgetTracker;
	/** When true, a denial that matches a safe deterministic repair rule is repaired and re-verified. Default false. */
	enableAutoRepair?: boolean;
}

export interface DiffDelta {
	filePath: string;
	addedLines: number;
	changedLines: number;
}

function safeRealpath(targetPath: string, depth = 0): string {
	if (depth > 32) return resolve(targetPath);
	const abs = resolve(targetPath);
	try {
		return realpathSync(abs);
	} catch {
		// Target does not exist yet or is a dangling symlink.
	}
	try {
		const st = lstatSync(abs);
		if (st.isSymbolicLink()) {
			const linkTarget = readlinkSync(abs);
			const resolvedLink = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(abs), linkTarget);
			return safeRealpath(resolvedLink, depth + 1);
		}
	} catch {
		// Target does not exist; resolve nearest existing ancestor.
	}
	const parent = dirname(abs);
	if (parent === abs) return abs;
	return join(safeRealpath(parent, depth + 1), basename(abs));
}

function globToRegExp(pattern: string): RegExp {
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				const prevIsSlash = i === 0 || pattern[i - 1] === "/";
				const nextIsSlash = pattern[i + 2] === "/";
				if (prevIsSlash && nextIsSlash) {
					regex += "(?:.+/)?";
					i += 3;
					continue;
				}
				regex += ".*";
				i += 2;
				continue;
			}
			regex += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			regex += "[^/]";
			i += 1;
			continue;
		}
		if ("\\^$.|+()[]{}".includes(ch)) {
			regex += `\\${ch}`;
		} else {
			regex += ch;
		}
		i += 1;
	}
	regex += "$";
	return new RegExp(regex);
}

function matchesScopePattern(relTarget: string, canonicalTargetNorm: string, pattern: string): boolean {
	if (isAbsolute(pattern)) {
		const firstGlob = pattern.search(/[*?]/);
		if (firstGlob === -1) {
			const canonicalPattern = safeRealpath(pattern).replace(/\\/g, "/");
			const trimmed = canonicalPattern.endsWith("/") ? canonicalPattern.slice(0, -1) : canonicalPattern;
			return canonicalTargetNorm === trimmed || canonicalTargetNorm.startsWith(`${trimmed}/`);
		}
		const prefixEnd = pattern.lastIndexOf("/", firstGlob);
		const prefix = prefixEnd >= 0 ? pattern.slice(0, prefixEnd) || "/" : "/";
		const globSuffix = pattern.slice(prefixEnd + 1).replace(/\\/g, "/");
		const canonicalPrefix = safeRealpath(prefix).replace(/\\/g, "/");
		const fullPattern = canonicalPrefix.endsWith("/")
			? `${canonicalPrefix}${globSuffix}`
			: `${canonicalPrefix}/${globSuffix}`;
		return globToRegExp(fullPattern).test(canonicalTargetNorm);
	}

	if (relTarget === "" || relTarget === ".." || relTarget.startsWith("../") || isAbsolute(relTarget)) {
		return false;
	}

	const trimmedPattern = pattern.replace(/\\/g, "/").trim();
	if (!trimmedPattern) return false;
	if (trimmedPattern === "." || /^(?:\.\/)+\.?$/.test(trimmedPattern)) {
		return true;
	}

	const normalized = trimmedPattern.replace(/^(?:\.\/)+/, "");
	if (!normalized) return false;
	if (normalized.endsWith("/")) {
		return relTarget.startsWith(normalized);
	}
	if (!normalized.includes("*") && !normalized.includes("?")) {
		return relTarget === normalized || relTarget.startsWith(`${normalized}/`);
	}
	return globToRegExp(normalized).test(relTarget);
}

export function checkScopeLock(filePath: string, scopeLock: TaskScopeLock): InvariantViolation | null {
	if (!filePath || filePath.includes("\0")) {
		return {
			domain: "filesystem",
			rule: "scope_lock",
			target: filePath,
			explanation: `Scope lock violation: invalid target path '${filePath}'.`,
		};
	}

	const baseCwd = scopeLock.cwd ? resolve(scopeLock.cwd) : process.cwd();
	const canonicalCwd = safeRealpath(baseCwd);
	const absTarget = resolve(baseCwd, filePath);
	const canonicalTarget = safeRealpath(absTarget);
	const canonicalTargetNorm = canonicalTarget.replace(/\\/g, "/");
	const relTarget = relative(canonicalCwd, canonicalTarget).replace(/\\/g, "/");

	const matched = scopeLock.allowedPaths.some((pattern) =>
		matchesScopePattern(relTarget, canonicalTargetNorm, pattern),
	);
	if (!matched) {
		return {
			domain: "filesystem",
			rule: "scope_lock",
			target: filePath,
			explanation: `Scope lock violation: '${filePath}' (resolved: '${canonicalTargetNorm}') is outside allowedPaths [${scopeLock.allowedPaths.join(", ")}].`,
		};
	}

	if (scopeLock.allowNewFiles === false && !existsSync(absTarget)) {
		return {
			domain: "filesystem",
			rule: "scope_lock",
			target: filePath,
			explanation: `Scope lock violation: creating new file '${filePath}' is disallowed when allowNewFiles is false.`,
		};
	}

	return null;
}

function splitLines(text: string): string[] {
	if (!text) return [];
	const normalized = text.replace(/\r\n/g, "\n");
	const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
	return trimmed ? trimmed.split("\n") : [];
}

function computeLineDiffCounts(oldText: string, newText: string): { addedLines: number; changedLines: number } {
	if (oldText === newText) return { addedLines: 0, changedLines: 0 };
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);

	if (oldLines.length === 0) {
		return { addedLines: newLines.length, changedLines: newLines.length };
	}
	if (newLines.length === 0) {
		return { addedLines: 0, changedLines: oldLines.length };
	}

	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
		start++;
	}
	let oldEnd = oldLines.length - 1;
	let newEnd = newLines.length - 1;
	while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
		oldEnd--;
		newEnd--;
	}

	const m = oldEnd - start + 1;
	const n = newEnd - start + 1;
	if (m === 0) return { addedLines: n, changedLines: n };
	if (n === 0) return { addedLines: 0, changedLines: m };

	let lcs = 0;
	if (m * n <= 250_000) {
		const prev = new Uint32Array(n + 1);
		const curr = new Uint32Array(n + 1);
		for (let i = 1; i <= m; i++) {
			const oldLine = oldLines[start + i - 1];
			for (let j = 1; j <= n; j++) {
				if (oldLine === newLines[start + j - 1]) {
					curr[j] = prev[j - 1] + 1;
				} else {
					curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1];
				}
			}
			prev.set(curr);
		}
		lcs = prev[n];
	} else {
		// Linear-time multiset fallback for huge diffs to preserve p95 <= 5ms latency.
		const oldCounts = new Map<string, number>();
		for (let i = start; i <= oldEnd; i++) {
			const line = oldLines[i];
			oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
		}
		for (let j = start; j <= newEnd; j++) {
			const line = newLines[j];
			const count = oldCounts.get(line) ?? 0;
			if (count > 0) {
				oldCounts.set(line, count - 1);
				lcs++;
			}
		}
	}

	const addedLines = n - lcs;
	const deletedLines = m - lcs;
	return { addedLines, changedLines: addedLines + deletedLines };
}

export function computeToolDiffDelta(
	toolName: string,
	params: Record<string, unknown>,
	cwd: string = process.cwd(),
): DiffDelta | null {
	const filePath = String(params.path || params.filePath || params.file_path || "");
	if (!filePath) return null;
	const resolvedPath = resolve(cwd, filePath);

	if (toolName === "edit") {
		if (Array.isArray(params.edits)) {
			let addedLines = 0;
			let changedLines = 0;
			for (const e of params.edits) {
				if (!e || typeof e !== "object") continue;
				const editObj = e as { oldText?: unknown; newText?: unknown };
				const diff = computeLineDiffCounts(String(editObj.oldText ?? ""), String(editObj.newText ?? ""));
				addedLines += diff.addedLines;
				changedLines += diff.changedLines;
			}
			return { filePath: resolvedPath, addedLines, changedLines };
		}
		if (params.oldText !== undefined || params.newText !== undefined) {
			const diff = computeLineDiffCounts(String(params.oldText ?? ""), String(params.newText ?? ""));
			return { filePath: resolvedPath, addedLines: diff.addedLines, changedLines: diff.changedLines };
		}
	}

	const newContent = params.content ?? params.code ?? params.newText;
	if (newContent === undefined) {
		return { filePath: resolvedPath, addedLines: 0, changedLines: 0 };
	}
	const oldContent = existsSync(resolvedPath) ? readFileSync(resolvedPath, "utf-8") : "";
	const diff = computeLineDiffCounts(oldContent, String(newContent));
	return { filePath: resolvedPath, addedLines: diff.addedLines, changedLines: diff.changedLines };
}

export class DiffBudgetTracker {
	private readonly touchedFiles = new Set<string>();
	private addedLines = 0;
	private changedLines = 0;

	getSnapshot(): { filesTouched: number; addedLines: number; changedLines: number; files: string[] } {
		return {
			filesTouched: this.touchedFiles.size,
			addedLines: this.addedLines,
			changedLines: this.changedLines,
			files: [...this.touchedFiles],
		};
	}

	checkDelta(delta: DiffDelta, budget: DiffBudget, rawTarget?: string): InvariantViolation | null {
		const normalized = safeRealpath(delta.filePath);
		const target = rawTarget ?? delta.filePath;
		const projectedFiles = this.touchedFiles.size + (this.touchedFiles.has(normalized) ? 0 : 1);
		if (budget.maxFiles !== undefined && projectedFiles > budget.maxFiles) {
			return {
				domain: "filesystem",
				rule: "diff_budget_files",
				target,
				explanation: `Diff budget exceeded for ${target}: ${projectedFiles} files exceeds maxFiles=${budget.maxFiles}.`,
			};
		}

		const projectedAdded = this.addedLines + delta.addedLines;
		if (budget.maxAddedLines !== undefined && projectedAdded > budget.maxAddedLines) {
			return {
				domain: "filesystem",
				rule: "diff_budget_lines",
				target,
				explanation: `Diff budget exceeded for ${target}: ${projectedAdded} added lines (${delta.addedLines} in call + ${this.addedLines} cumulative) exceeds maxAddedLines=${budget.maxAddedLines}.`,
			};
		}

		const projectedChanged = this.changedLines + delta.changedLines;
		if (budget.maxChangedLines !== undefined && projectedChanged > budget.maxChangedLines) {
			return {
				domain: "filesystem",
				rule: "diff_budget_lines",
				target,
				explanation: `Diff budget exceeded for ${target}: ${projectedChanged} changed lines (${delta.changedLines} in call + ${this.changedLines} cumulative) exceeds maxChangedLines=${budget.maxChangedLines}.`,
			};
		}

		return null;
	}

	recordAllowed(delta: DiffDelta): void {
		this.touchedFiles.add(safeRealpath(delta.filePath));
		this.addedLines += delta.addedLines;
		this.changedLines += delta.changedLines;
	}
}

export function checkDiffBudget(
	toolName: string,
	params: Record<string, unknown>,
	budget: DiffBudget,
	tracker?: DiffBudgetTracker,
	cwd: string = process.cwd(),
): InvariantViolation | null {
	const delta = computeToolDiffDelta(toolName, params, cwd);
	if (!delta) return null;
	const rawTarget = String(params.path || params.filePath || params.file_path || delta.filePath);
	const effectiveTracker = tracker ?? new DiffBudgetTracker();
	return effectiveTracker.checkDelta(delta, budget, rawTarget);
}

const defaultClient = new System2Client();

/**
 * Verify a tool call. With `options.enableAutoRepair`, a denial is passed to the LeanGuard repair layer;
 * a repair is only returned after the repaired payload passes `verifyToolCallCore` again.
 */
export async function verifyToolCall(
	toolName: string,
	params: Record<string, any> | undefined,
	client: System2Client = defaultClient,
	options?: VerifyToolOptions,
): Promise<ToolVerificationResult> {
	const result = await verifyToolCallCore(toolName, params, client, options);
	if (result.allowed || !options?.enableAutoRepair || !params) return result;
	const repair = await attemptArgumentRepair(toolName, params, result, {
		client,
		guardPolicy: options.guardPolicy,
		budgetTracker: options.budgetTracker,
	});
	if (!repair.repaired || !repair.repairedParams) return result;
	return { allowed: true, decision: "allow", repairedParams: repair.repairedParams, repairRule: repair.repairRule };
}

/** The verification checks themselves, with no repair. `attemptArgumentRepair` re-verifies through this. */
export async function verifyToolCallCore(
	toolName: string,
	params: Record<string, any> | undefined,
	client: System2Client = defaultClient,
	options?: VerifyToolOptions,
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

	let recordedDelta: DiffDelta | null = null;
	if (["write", "edit", "write_file"].includes(toolName)) {
		const filePath = String(params.path || params.filePath || params.file_path || "");
		const scopeLock = options?.guardPolicy?.scopeLock;
		if (scopeLock) {
			const scopeViolation = checkScopeLock(filePath, scopeLock);
			if (scopeViolation) return block("SCOPE_LOCK_VIOLATION", scopeViolation);
		}

		const budget = options?.guardPolicy?.diffBudget;
		const cwd = scopeLock?.cwd ? resolve(scopeLock.cwd) : process.cwd();
		if (budget || options?.budgetTracker) {
			recordedDelta = computeToolDiffDelta(toolName, params, cwd);
			if (budget && recordedDelta) {
				const tracker = options?.budgetTracker ?? new DiffBudgetTracker();
				const budgetViolation = tracker.checkDelta(recordedDelta, budget, filePath);
				if (budgetViolation) return block("DIFF_BUDGET_EXCEEDED", budgetViolation);
			}
		}

		let content = params.content ?? params.code ?? params.newText;
		const resolvedFilePath = filePath ? resolve(cwd, filePath) : "";
		if (content === undefined && resolvedFilePath && existsSync(resolvedFilePath) && Array.isArray(params.edits)) {
			content = params.edits.reduce(
				(acc: string, e: any) => (e.oldText && e.newText !== undefined ? acc.replace(e.oldText, e.newText) : acc),
				readFileSync(resolvedFilePath, "utf-8"),
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

	if (recordedDelta && options?.budgetTracker) {
		options.budgetTracker.recordAllowed(recordedDelta);
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

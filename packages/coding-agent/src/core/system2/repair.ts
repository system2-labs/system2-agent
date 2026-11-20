// LeanGuard-style (arXiv:2611.02332) deterministic, intent-preserving argument repair for denied tool calls.
// Called from verifier.ts (`verifyToolCall` with `enableAutoRepair`) after a denial. Every repair is a pure string
// transform, and the repaired payload must pass `verifyToolCallCore` again before `repaired: true` is returned.
// The verifier stays the only authority: a repair can never allow something the verifier would still block.
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { System2Client } from "./client.ts";
import type { TaskGuardPolicy, TaskScopeLock, ToolVerificationResult } from "./types.ts";
import { type DiffBudgetTracker, verifyToolCallCore } from "./verifier.ts";

export interface ArgumentRepairResult {
	repaired: boolean;
	repairedParams?: Record<string, unknown>;
	repairRule?: string;
	explanation: string;
	latencyMs: number;
}

export interface ArgumentRepairOptions {
	guardPolicy?: TaskGuardPolicy;
	budgetTracker?: DiffBudgetTracker;
	client?: System2Client;
}

type Candidate = { rule: string; params: Record<string, unknown> };

const MUTATING_TOOLS = new Set(["write", "edit", "write_file"]);
const PATH_KEYS = ["path", "filePath", "file_path"] as const;
const CONTENT_KEYS = ["content", "code", "newText"] as const;
// Repairs chain at most this deep (e.g. path fix, then trailing-comma fix). Bounds latency.
const MAX_ROUNDS = 3;

/**
 * Try to turn a denied tool call into an allowed one with a safe deterministic rewrite.
 * Returns `repaired: false` for anything not covered by a rule, including every command-safety denial.
 */
export async function attemptArgumentRepair(
	toolName: string,
	params: Record<string, unknown>,
	verificationResult: ToolVerificationResult,
	options: ArgumentRepairOptions = {},
): Promise<ArgumentRepairResult> {
	const t0 = performance.now();
	const finish = (result: Omit<ArgumentRepairResult, "latencyMs">): ArgumentRepairResult => ({
		...result,
		latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
	});

	if (verificationResult.allowed)
		return finish({ repaired: false, explanation: "No repair needed: call was allowed." });
	// Only file-mutating tools have repair rules. Bash and every other tool are never rewritten, so a destructive
	// command cannot be turned into an allowed one by this layer.
	if (!MUTATING_TOOLS.has(toolName)) {
		return finish({ repaired: false, explanation: `No repair rule for tool '${toolName}'.` });
	}

	let current = params;
	let last = verificationResult;
	const rules: string[] = [];
	for (let round = 0; round < MAX_ROUNDS; round++) {
		let progressed = false;
		for (const candidate of candidatesFor(last.code, current, options.guardPolicy?.scopeLock)) {
			const check = await verifyToolCallCore(toolName, candidate.params, options.client, {
				guardPolicy: options.guardPolicy,
				budgetTracker: options.budgetTracker,
			});
			if (check.allowed) {
				rules.push(candidate.rule);
				return finish({
					repaired: true,
					repairedParams: candidate.params,
					repairRule: rules.join("+"),
					explanation: `Repaired ${last.code ?? "denial"} via ${rules.join(" + ")}; repaired call passed re-verification.`,
				});
			}
			// A different denial code means this rewrite cleared the first problem and exposed the next one.
			if (check.code !== last.code) {
				rules.push(candidate.rule);
				current = candidate.params;
				last = check;
				progressed = true;
				break;
			}
		}
		if (!progressed) break;
	}
	return finish({
		repaired: false,
		explanation: `No safe repair for ${verificationResult.code ?? "denial"}: ${verificationResult.reason ?? "unspecified"}`,
	});
}

function candidatesFor(
	code: string | undefined,
	params: Record<string, unknown>,
	scopeLock: TaskScopeLock | undefined,
): Candidate[] {
	if (code === "SCOPE_LOCK_VIOLATION" && scopeLock) return pathCandidates(params, scopeLock);
	if (code === "DIFF_BUDGET_EXCEEDED") return trailingBlankLineCandidates(params);
	if (code === "SYNTAX_ERROR_JSON") return jsonTrailingCommaCandidates(params);
	return [];
}

function findKey(params: Record<string, unknown>, keys: readonly string[]): string | undefined {
	return keys.find((key) => typeof params[key] === "string" && params[key] !== "");
}

function withValue(params: Record<string, unknown>, key: string, value: string): Record<string, unknown> {
	return { ...params, [key]: value };
}

// Rules 1 and 2: path formatting noise and unique bare-basename resolution.
function pathCandidates(params: Record<string, unknown>, scopeLock: TaskScopeLock): Candidate[] {
	const key = findKey(params, PATH_KEYS);
	if (!key) return [];
	const raw = params[key] as string;
	if (raw.includes("\0")) return [];
	const trimmed = raw.trim();
	const segments = trimmed.split("/");
	// Never repair traversal: `..` is an escape attempt or a different intent, not formatting noise.
	if (segments.includes("..")) return [];
	const cleaned = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
	if (!cleaned) return [];

	const cwd = scopeLock.cwd ? resolve(scopeLock.cwd) : process.cwd();
	const isAbsolute = trimmed.startsWith("/");
	const out: Candidate[] = [];
	if (isAbsolute) {
		// "/src/a.ts" -> "src/a.ts" only when the absolute spelling points at nothing real and the relative one
		// names an existing file or an exact allowed entry. Otherwise it is a genuine absolute target.
		const relExists = existsSync(resolve(cwd, cleaned)) || exactFileEntries(scopeLock).includes(cleaned);
		if (!existsSync(trimmed) && !existsSync(dirname(trimmed)) && relExists) {
			out.push({ rule: "path_leading_slash", params: withValue(params, key, cleaned) });
		}
		return out;
	}
	if (cleaned !== raw) out.push({ rule: "path_normalize", params: withValue(params, key, cleaned) });
	if (!cleaned.includes("/") && !existsSync(resolve(cwd, cleaned))) {
		// Exactly one allowed exact-file entry with this basename, and no real file of that name at cwd root.
		const matches = exactFileEntries(scopeLock).filter(
			(entry) => entry.slice(entry.lastIndexOf("/") + 1) === cleaned,
		);
		if (matches.length === 1 && matches[0] !== cleaned) {
			out.push({ rule: "path_basename_resolve", params: withValue(params, key, matches[0]) });
		}
	}
	return out;
}

// Unique relative allowedPaths entries that name a single file (no glob, no directory prefix).
function exactFileEntries(scopeLock: TaskScopeLock): string[] {
	const cwd = scopeLock.cwd ? resolve(scopeLock.cwd) : process.cwd();
	const entries = new Set<string>();
	for (const pattern of scopeLock.allowedPaths) {
		const entry = pattern
			.replace(/\\/g, "/")
			.trim()
			.replace(/^(?:\.\/)+/, "");
		if (!entry || entry.startsWith("/") || entry.endsWith("/") || /[*?]/.test(entry)) continue;
		const abs = resolve(cwd, entry);
		if (existsSync(abs) && statSync(abs).isDirectory()) continue;
		entries.add(entry);
	}
	return [...entries];
}

// Rule 3: a write that busts the budget only because of trailing blank lines.
function trailingBlankLineCandidates(params: Record<string, unknown>): Candidate[] {
	const key = findKey(params, CONTENT_KEYS);
	if (!key) return [];
	const content = params[key] as string;
	// Manual scan from the end: a `\s+$` regex backtracks quadratically on long whitespace-heavy content.
	let end = content.length;
	while (end > 0 && /\s/.test(content[end - 1])) end--;
	if (end === 0) return [];
	const trimmed = `${content.slice(0, end)}\n`;
	const trailing = content.slice(end);
	if (trailing.split("\n").length - 1 < 2) return [];
	return [{ rule: "diff_budget_trailing_blank_lines", params: withValue(params, key, trimmed) }];
}

// Rule 4: JSON that fails only because of a comma before a closing bracket.
function jsonTrailingCommaCandidates(params: Record<string, unknown>): Candidate[] {
	const key = findKey(params, CONTENT_KEYS);
	const pathKey = findKey(params, PATH_KEYS);
	if (!key || !pathKey || !(params[pathKey] as string).endsWith(".json")) return [];
	const content = params[key] as string;
	const fixed = stripTrailingCommas(content);
	if (fixed === content) return [];
	try {
		JSON.parse(fixed);
	} catch {
		return [];
	}
	return [{ rule: "json_trailing_comma", params: withValue(params, key, fixed) }];
}

// String-aware so a "," followed by "}" inside a JSON string value is never touched.
function stripTrailingCommas(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === "\\") out += text[++i] ?? "";
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Antigravity (`agy`) CLI bridge: System 2 Tier-3 subscription adapter.
 * Resolves the agy binary, model, and effort, runs `agy -p ...` in an
 * isolated HOME (OAuth symlink only, secrets stripped from env), parses
 * stream-JSON output, and classifies quota / auth-contention failures.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export type AgyEffort = "low" | "medium" | "high";

export type AgyCatalog = Record<string, readonly AgyEffort[]>;

/** Effort levels known for each agy subscription model. An empty list means the model takes no `--effort`. */
export const KNOWN_AGY_EFFORTS: AgyCatalog = {
	"gemini-3.8-flash": ["low", "medium", "high"],
	"gemini-3.7-flash": ["low", "medium", "high"],
	"gemini-3.1-pro": ["low", "high"],
	"claude-sonnet-4-6": [],
	"claude-opus-4-6-thinking": [],
	"gpt-oss-120b": ["medium"],
};

/** Short alias to agy model id, as accepted by `resolveAgyModelAndEffort`. */
export const AGY_MODEL_ALIASES: Record<string, string> = {
	default: "gemini-3.8-flash",
	flash: "gemini-3.8-flash",
	pro: "gemini-3.1-pro",
	sonnet: "claude-sonnet-4-6",
	opus: "claude-opus-4-6-thinking",
};

export interface AgyPromptRequest {
	prompt: string;
	model?: string;
	effort?: string;
	conversationId?: string;
	cwd?: string;
	timeoutMs?: number;
	/** Run in a fresh temp HOME with the OAuth token symlinked (default true). */
	isolateHome?: boolean;
	realHomeDir?: string;
	/** Test seam: replace the default execFileSync runner. */
	runner?: (
		cmd: string,
		args: readonly string[],
		options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
	) => { stdout: string; stderr: string; exitCode: number };
}

export interface AgyPromptResult {
	ok: boolean;
	text: string;
	model: string;
	effort?: AgyEffort;
	conversationId?: string;
	errorKind?: "quota" | "auth_contention" | "process_error";
	errorDetail?: string;
}

const EFFORT_ALIASES: Record<string, AgyEffort> = {
	none: "low",
	off: "low",
	minimal: "low",
	xhigh: "high",
	max: "high",
	ultra: "high",
};

/** Normalize a user-supplied effort string to the agy `--effort` vocabulary, defaulting unrecognized values to "medium". */
export function normalizeAgyEffort(effort?: string): AgyEffort | undefined {
	if (!effort) return undefined;
	const raw = effort.trim().toLowerCase();
	if (raw === "") return undefined;
	if (raw in EFFORT_ALIASES) return EFFORT_ALIASES[raw];
	if (raw === "low" || raw === "medium" || raw === "high") return raw;
	return "medium";
}

/** Strip an `agy/` or `antigravity/` prefix and a trailing `-low|-medium|-high` effort suffix. */
export function splitAgyEffortSuffix(modelId: string): { base: string; effort?: AgyEffort } {
	const stripped = modelId.replace(/^(agy|antigravity)\//, "");
	for (const effort of ["high", "medium", "low"] as const) {
		const suffix = `-${effort}`;
		if (stripped.endsWith(suffix)) return { base: stripped.slice(0, -suffix.length), effort };
	}
	return { base: stripped };
}

/** Parse `agy models` stdout into a catalog, skipping spinner/noise lines and grouping efforts in low/medium/high order. */
export function parseAgyModelCatalog(stdout: string): AgyCatalog {
	const grouped: Record<string, Set<AgyEffort>> = {};
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (/^(error:|usage:|available models:|warning:|--)/i.test(trimmed)) continue;
		if (/fetching/i.test(trimmed)) continue;
		const token = trimmed.split(/\s+/)[0];
		if (!/^[a-zA-Z0-9_.-]+$/.test(token)) continue;
		const { base, effort } = splitAgyEffortSuffix(token);
		if (!grouped[base]) grouped[base] = new Set();
		if (effort) grouped[base].add(effort);
	}
	const order = ["low", "medium", "high"] as const;
	const catalog: AgyCatalog = {};
	for (const [base, efforts] of Object.entries(grouped)) catalog[base] = order.filter((e) => efforts.has(e));
	return catalog;
}

/**
 * Resolve the agy model id and `--effort` value for a prompt.
 * Applies aliases, strips prefixes/suffixes, and clamps the effort to the
 * model's supported list; models with no supported efforts take no `--effort`.
 */
export function resolveAgyModelAndEffort(
	requestedModel?: string,
	requestedEffort?: string,
	catalog: AgyCatalog = KNOWN_AGY_EFFORTS,
): { model: string; effort?: AgyEffort } {
	const raw = requestedModel && requestedModel.trim() !== "" ? requestedModel.trim() : "gemini-3.8-flash";
	const { base: baseOnce, effort: suffixEffort } = splitAgyEffortSuffix(AGY_MODEL_ALIASES[raw] ?? raw);
	const base = AGY_MODEL_ALIASES[baseOnce] ?? baseOnce;
	const supported = catalog[base] ?? KNOWN_AGY_EFFORTS[base];
	if (supported && supported.length === 0) return { model: base };
	const desired = normalizeAgyEffort(requestedEffort) ?? suffixEffort ?? "medium";
	if (supported?.includes(desired)) return { model: base, effort: desired };
	return { model: base, effort: supported && supported.length > 0 ? supported[supported.length - 1] : "medium" };
}

function isExecutableFile(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Locate the agy binary via ANTIGRAVITY_COMMAND/AGY_CLI_PATH/ANTIGRAVITY_CLI_PATH, then well-known paths, else bare "agy". */
export function resolveAgyCommand(env: NodeJS.ProcessEnv = process.env): string {
	const envPath = [env.ANTIGRAVITY_COMMAND, env.AGY_CLI_PATH, env.ANTIGRAVITY_CLI_PATH].find(
		(p) => p && p.trim() !== "",
	);
	if (envPath && isExecutableFile(envPath.trim())) return envPath.trim();
	for (const candidate of [join(homedir(), ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]) {
		if (isExecutableFile(candidate)) return candidate;
	}
	return "agy";
}

const SENSITIVE_ENV_KEY = /(_API_KEY|_SECRET|_TOKEN|_ACCESS_KEY|PASSWORD)/i;
const SENSITIVE_ENV_KEEP = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"]);

/** Copy of base env for the agy child process: secrets stripped, auto-update off, optional isolated HOME. */
export function buildAgyChildEnv(baseEnv: NodeJS.ProcessEnv = process.env, tempHome?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value === undefined) continue;
		if (SENSITIVE_ENV_KEEP.has(key)) {
			env[key] = value;
			continue;
		}
		if (!SENSITIVE_ENV_KEY.test(key)) env[key] = value;
	}
	env.AGY_DISABLE_AUTO_UPDATE = "1";
	if (tempHome) env.HOME = tempHome;
	return env;
}

/**
 * Create a temp HOME for agy with only the OAuth token (and, on macOS, Keychains) symlinked in,
 * so the subscription login works without the child seeing the full real HOME.
 */
export function setupIsolatedAgyHome(realHomeDir: string = homedir()): { tempHome: string; cleanup: () => void } {
	const tempHome = mkdtempSync(join(tmpdir(), "s2-agy-home-"));
	try {
		const tokenSrc = join(realHomeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
		if (existsSync(tokenSrc)) {
			const tokenDir = join(tempHome, ".gemini", "antigravity-cli");
			mkdirSync(tokenDir, { recursive: true });
			symlinkSync(tokenSrc, join(tokenDir, "antigravity-oauth-token"));
		}
		if (platform() === "darwin") {
			const keychainsSrc = join(realHomeDir, "Library", "Keychains");
			if (existsSync(keychainsSrc)) {
				mkdirSync(join(tempHome, "Library"), { recursive: true });
				symlinkSync(keychainsSrc, join(tempHome, "Library", "Keychains"));
			}
		}
	} catch (error) {
		rmSync(tempHome, { recursive: true, force: true });
		throw error;
	}
	return { tempHome, cleanup: () => rmSync(tempHome, { recursive: true, force: true }) };
}

const AUTH_CONTENTION_RE = /not logged into antigravity|error getting token source|oauth token refresh failed/i;
const QUOTA_RE = /0%\s+remaining|quota exhausted|resource_exhausted|rate limit exceeded for model/i;

/** Classify agy output as a quota exhaustion, an auth-contention failure, or no known error. */
export function detectAgyAuthOrQuotaError(output: string): {
	kind: "quota" | "auth_contention" | "none";
	detail?: string;
} {
	const auth = AUTH_CONTENTION_RE.exec(output);
	if (auth) return { kind: "auth_contention", detail: auth[0] };
	const quota = QUOTA_RE.exec(output);
	if (quota) return { kind: "quota", detail: quota[0] };
	return { kind: "none" };
}

/** Extract assistant text and conversation id from stream-JSON (JSONL) output, falling back to the raw trimmed text. */
export function parseAgyStreamJsonOutput(rawOutput: string): { text: string; conversationId?: string } {
	let text = "";
	let conversationId: string | undefined;
	let matched = false;
	for (const line of rawOutput.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || !trimmed.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		matched = true;
		const record = parsed as Record<string, unknown>;
		for (const key of ["content", "text", "delta", "result"]) {
			const value = record[key];
			if (typeof value !== "string") continue;
			const chunk = value.trim();
			if (chunk === "") continue;
			text += (text === "" ? "" : "\n") + chunk;
		}
		for (const key of ["conversation_id", "conversationId"]) {
			if (typeof record[key] === "string") conversationId = record[key] as string;
		}
	}
	if (matched) return { text: text.trim(), conversationId };
	return { text: rawOutput.trim() };
}

function defaultAgyRunner(
	cmd: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync(cmd, [...args], {
			cwd: options.cwd,
			env: options.env,
			timeout: options.timeoutMs,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		return { stdout: String(stdout), stderr: "", exitCode: 0 };
	} catch (error) {
		// execFileSync throws on non-zero exit; recover the child's streams and status from the error.
		const e = error as { message?: string; code?: unknown; stdout?: unknown; stderr?: unknown };
		return {
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? String(error)),
			exitCode: typeof e.code === "number" ? e.code : 1,
		};
	}
}

/** Run one agy prompt end-to-end: resolve model/effort, isolate HOME, exec, parse, and classify the result. */
export async function runAgyPrompt(req: AgyPromptRequest): Promise<AgyPromptResult> {
	const { model, effort } = resolveAgyModelAndEffort(req.model, req.effort);
	const args: string[] = ["-p", req.prompt, "--model", model];
	if (effort) args.push("--effort", effort);
	if (req.conversationId) args.push("--conversation", req.conversationId);

	const isolated = req.isolateHome !== false ? setupIsolatedAgyHome(req.realHomeDir) : undefined;
	try {
		const runner = req.runner ?? defaultAgyRunner;
		let run: { stdout: string; stderr: string; exitCode: number };
		try {
			run = runner(resolveAgyCommand(), args, {
				cwd: req.cwd,
				env: buildAgyChildEnv(process.env, isolated?.tempHome),
				timeoutMs: req.timeoutMs ?? 300_000,
			});
		} catch (error) {
			run = { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
		}
		const parsed = parseAgyStreamJsonOutput(run.stdout);
		const failure = detectAgyAuthOrQuotaError(`${run.stdout}\n${run.stderr}`);
		if (failure.kind !== "none") {
			return {
				ok: false,
				text: parsed.text,
				model,
				effort,
				conversationId: parsed.conversationId,
				errorKind: failure.kind,
				errorDetail: failure.detail,
			};
		}
		if (run.exitCode !== 0) {
			return {
				ok: false,
				text: parsed.text,
				model,
				effort,
				conversationId: parsed.conversationId,
				errorKind: "process_error",
				errorDetail: run.stderr.trim(),
			};
		}
		return { ok: true, text: parsed.text, model, effort, conversationId: parsed.conversationId };
	} finally {
		isolated?.cleanup();
	}
}

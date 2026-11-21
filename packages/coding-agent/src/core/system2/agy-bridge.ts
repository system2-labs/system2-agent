/**
 * Antigravity (`agy`) CLI bridge: System 2 Tier-3 subscription adapter.
 * Resolves the agy binary, model, and effort, runs `agy -p ...` in an
 * isolated HOME (OAuth symlink only, secrets stripped from env), parses
 * stream-JSON output, and classifies quota / auth-contention failures.
 */

import { execFileSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
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

/** Known OAuth token basenames ordered newest-first; agy 1.2 reads `jetski-standalone-oauth-token` and leaves legacy files behind. */
export const AGY_OAUTH_TOKEN_FILENAMES = ["jetski-standalone-oauth-token", "antigravity-oauth-token"] as const;

export interface IsolatedAgyHomeOptions {
	realHomeDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Whether to symlink ~/Library/Keychains on macOS. Defaults to false when a token file or ANTIGRAVITY_CONFIG_DIR is present, true only on darwin when no token file exists. */
	linkKeychains?: boolean;
}

export interface AgyPromptRequest {
	prompt: string;
	model?: string;
	effort?: string;
	conversationId?: string;
	mode?: string;
	/** Pass `--disable-slash-commands` so prompt content cannot invoke CLI slash commands (default true). */
	disableSlashCommands?: boolean;
	/** Output format passed to `--output-format` (default "stream-json"). */
	outputFormat?: "stream-json" | "json" | "text";
	cwd?: string;
	timeoutMs?: number;
	/** Run in a fresh temp HOME with the OAuth token symlinked (default true). */
	isolateHome?: boolean;
	realHomeDir?: string;
	/** Override macOS `~/Library/Keychains` symlinking when `isolateHome` is enabled. */
	linkKeychains?: boolean;
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

// Credential name heuristic matching Hermes `process.py`: strips tokens, secrets, passwords, keys, webhooks, DSNs,
// cookies, and database/broker URIs so the closed-source agy child never inherits host secrets.
const SENSITIVE_ENV_KEY =
	/(^|_)(TOKENS?|SECRETS?|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|WEBHOOKS?|DSN|COOKIES?)($|_)|(^|_)(DATABASE|DB|REDIS|MONGO\w*|POSTGRES\w*|MYSQL|AMQP|BROKER|CACHE)_(URL|URI)($|_)/i;

// Safe exceptions that match SENSITIVE_ENV_KEY (e.g. AUTH in SSH_AUTH_SOCK) or stay preserved in default mode.
const SENSITIVE_ENV_KEEP = new Set([
	"PATH",
	"HOME",
	"USER",
	"LANG",
	"TERM",
	"TMPDIR",
	"SSH_AUTH_SOCK",
	"GPG_AGENT_INFO",
]);

const STRICT_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

// Minimal baseline allowed under `ANTIGRAVITY_ENV_STRICT` (plus `LC_*`, allowlist, and passthrough vars).
const STRICT_ENV_BASELINE = new Set([
	"PATH",
	"HOME",
	"USER",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"TMPDIR",
	"TEMP",
	"TMP",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"SSH_AUTH_SOCK",
	"DBUS_SESSION_BUS_ADDRESS",
	"XDG_RUNTIME_DIR",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"AGY_CLI_DISABLE_AUTO_UPDATE",
	"AGY_DISABLE_AUTO_UPDATE",
	"AGY_CLI_MODEL_API_MAX_RETRIES",
]);

function parseCsvEnvNames(raw: string | undefined, normalize: (name: string) => string): Set<string> {
	const names = new Set<string>();
	if (!raw) return names;
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed !== "") names.add(normalize(trimmed));
	}
	return names;
}

/**
 * Copy of base env for the agy child process: strips secret-like vars (or enforces the strict allowlist when
 * `ANTIGRAVITY_ENV_STRICT` is set), disables auto-update, and optionally points HOME/USERPROFILE at `tempHome`.
 */
export function buildAgyChildEnv(baseEnv: NodeJS.ProcessEnv = process.env, tempHome?: string): NodeJS.ProcessEnv {
	const isWin32 = platform() === "win32";
	const norm = (name: string): string => (isWin32 ? name.toUpperCase() : name);
	const passthrough = parseCsvEnvNames(baseEnv.ANTIGRAVITY_ENV_PASSTHROUGH, norm);
	const strict = STRICT_ENV_VALUES.has((baseEnv.ANTIGRAVITY_ENV_STRICT ?? "").trim().toLowerCase());
	const env: NodeJS.ProcessEnv = {};

	if (strict) {
		const allowed = new Set<string>(passthrough);
		for (const name of STRICT_ENV_BASELINE) allowed.add(norm(name));
		for (const name of parseCsvEnvNames(baseEnv.ANTIGRAVITY_ENV_ALLOWLIST, norm)) allowed.add(name);
		for (const [key, value] of Object.entries(baseEnv)) {
			if (value === undefined) continue;
			if (allowed.has(norm(key)) || key.toUpperCase().startsWith("LC_")) env[key] = value;
		}
	} else {
		const safe = isWin32 ? new Set(Array.from(SENSITIVE_ENV_KEEP, norm)) : SENSITIVE_ENV_KEEP;
		for (const [key, value] of Object.entries(baseEnv)) {
			if (value === undefined) continue;
			const normalizedKey = norm(key);
			if (passthrough.has(normalizedKey) || safe.has(normalizedKey) || !SENSITIVE_ENV_KEY.test(key)) {
				env[key] = value;
			}
		}
	}

	env.AGY_DISABLE_AUTO_UPDATE = "1";
	env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
	if (tempHome) {
		env.HOME = tempHome;
		env.USERPROFILE = tempHome;
	}
	return env;
}

/**
 * Locate the host Antigravity OAuth token file without reading its contents.
 * When `ANTIGRAVITY_CONFIG_DIR` is set, only that directory is searched so an explicit override never silently falls
 * back to `realHomeDir`.
 */
export function resolveRealAgyTokenPath(
	realHomeDir: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): { path: string; filename: string } | undefined {
	const explicitConfigDir = env.ANTIGRAVITY_CONFIG_DIR?.trim();
	const searchDir = explicitConfigDir ? explicitConfigDir : join(realHomeDir, ".gemini", "antigravity-cli");
	for (const filename of AGY_OAUTH_TOKEN_FILENAMES) {
		const candidate = join(searchDir, filename);
		try {
			if (statSync(candidate).isFile()) return { path: candidate, filename };
		} catch {
			// Absent, dangling symlink, or unreadable path; check the next known filename.
		}
	}
	return undefined;
}

/**
 * Create a `0o700` temp HOME for agy with only the resolved OAuth token (and, on macOS when needed, Keychains)
 * symlinked in, so the subscription login works without exposing the full real HOME.
 */
export function setupIsolatedAgyHome(realHomeDirOrOptions: string | IsolatedAgyHomeOptions = homedir()): {
	tempHome: string;
	linkedPaths: string[];
	cleanup: () => void;
} {
	const options: IsolatedAgyHomeOptions =
		typeof realHomeDirOrOptions === "string" ? { realHomeDir: realHomeDirOrOptions } : realHomeDirOrOptions;
	const realHomeDir = options.realHomeDir ?? homedir();
	const env = options.env ?? process.env;
	const tempHome = mkdtempSync(join(tmpdir(), "s2-agy-home-"));
	const linkedPaths: string[] = [];

	// Explicitly unlink every created symlink before recursive removal so a directory symlink (such as Keychains)
	// can never be traversed or touched if `rmSync` runs on teardown or setup error.
	const cleanup = (): void => {
		for (const linkedPath of linkedPaths) {
			try {
				if (lstatSync(linkedPath).isSymbolicLink()) unlinkSync(linkedPath);
			} catch {
				// Already unlinked or missing; continue removing tempHome.
			}
		}
		rmSync(tempHome, { recursive: true, force: true });
	};

	try {
		// Lock tempHome to owner-only before creating auth symlinks inside it.
		chmodSync(tempHome, 0o700);
		const resolvedToken = resolveRealAgyTokenPath(realHomeDir, env);
		if (resolvedToken) {
			const tokenDir = join(tempHome, ".gemini", "antigravity-cli");
			mkdirSync(tokenDir, { recursive: true });
			const tokenLink = join(tokenDir, resolvedToken.filename);
			symlinkSync(resolvedToken.path, tokenLink);
			linkedPaths.push(tokenLink);
		}
		// Gate macOS Keychains access: never expose Keychains under an explicit ANTIGRAVITY_CONFIG_DIR or when
		// disabled; otherwise expose on darwin only when no file token exists or the caller explicitly opted in.
		const hasExplicitConfigDir = Boolean(env.ANTIGRAVITY_CONFIG_DIR?.trim());
		const shouldLinkKeychains =
			platform() === "darwin" &&
			!hasExplicitConfigDir &&
			options.linkKeychains !== false &&
			(options.linkKeychains === true || resolvedToken === undefined);
		if (shouldLinkKeychains) {
			const keychainsSrc = join(realHomeDir, "Library", "Keychains");
			if (existsSync(keychainsSrc)) {
				mkdirSync(join(tempHome, "Library"), { recursive: true });
				const keychainsLink = join(tempHome, "Library", "Keychains");
				symlinkSync(keychainsSrc, keychainsLink);
				linkedPaths.push(keychainsLink);
			}
		}
	} catch (error) {
		cleanup();
		throw error;
	}
	return { tempHome, linkedPaths, cleanup };
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
	const args: string[] = ["-p", req.prompt, "--output-format", req.outputFormat ?? "stream-json"];
	if (req.disableSlashCommands !== false) args.push("--disable-slash-commands");
	if (req.mode && req.mode.trim() !== "") args.push("--mode", req.mode.trim());
	args.push("--model", model);
	if (effort) args.push("--effort", effort);
	if (req.conversationId) args.push("--conversation", req.conversationId);

	const isolated =
		req.isolateHome !== false
			? setupIsolatedAgyHome({ realHomeDir: req.realHomeDir, linkKeychains: req.linkKeychains })
			: undefined;
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

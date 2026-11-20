// Caper-style (arXiv:2610.40753) bounded, consequence-aware post-execution inspection.
// Pre-execution checks cannot see what an opaque `bash` command will do (`sh -c "echo x >> ../outside"`), so after
// the tool ends agent-session.ts calls `inspectExecutionConsequences` to measure what actually changed on disk
// against the pre-tool WorktreeSnapshot, then `evaluateConsequencePolicy` to decide whether to roll back.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { WorktreeSnapshot } from "./checkpoint.ts";
import type { TaskGuardPolicy, ToolVerificationResult } from "./types.ts";
import { checkScopeLock } from "./verifier.ts";

export interface ExecutionConsequenceReport {
	cwd: string;
	/** Paths below are relative to `cwd` (may start with `../` for changes elsewhere in the same repo). */
	modifiedFiles: string[];
	addedFiles: string[];
	deletedFiles: string[];
	totalAddedLines: number;
	totalDeletedLines: number;
	outOfScopeFiles: string[];
	deletedTrackedFiles: string[];
	summary: string;
	latencyMs: number;
}

// Bounds keep p95 low: git calls time out, and untracked-file line counting reads at most this many bytes.
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_COUNT_BYTES = 1024 * 1024;

/**
 * Summarise the filesystem side effects since `snapshot`: tracked changes via `git diff --raw --numstat` against
 * the snapshot base, new files via `git status --porcelain`. When `guardPolicy.scopeLock` is set, also lists
 * changed files outside it. A directory that is not a git repository yields an empty report.
 */
export function inspectExecutionConsequences(
	snapshot: WorktreeSnapshot,
	guardPolicy?: TaskGuardPolicy,
): ExecutionConsequenceReport {
	const t0 = performance.now();
	const base = snapshot.stashSha || snapshot.headSha;
	const empty = (summary: string): ExecutionConsequenceReport => ({
		cwd: snapshot.cwd,
		modifiedFiles: [],
		addedFiles: [],
		deletedFiles: [],
		totalAddedLines: 0,
		totalDeletedLines: 0,
		outOfScopeFiles: [],
		deletedTrackedFiles: [],
		summary,
		latencyMs: elapsed(t0),
	});
	if (snapshot.isGitRepo === false || !base)
		return empty("Snapshot is not a git repository or has no baseline; consequences not inspected.");

	let realCwd: string;
	try {
		realCwd = realpathSync(snapshot.cwd);
	} catch {
		return empty("Snapshot cwd no longer exists; consequences not inspected.");
	}
	// Walking up for `.git` avoids a `git rev-parse` spawn (about a third of the latency budget). A `.git` file
	// (linked worktree) counts too. Paths from git below are relative to this root.
	const root = findRepoRoot(realCwd);
	if (!root) return empty("Not a git repository; consequences not inspected.");

	// Normalize root via realpathSync to handle symlinks like macOS `/var` -> `/private/var`
	let resolvedRoot: string;
	try {
		resolvedRoot = realpathSync(root);
	} catch {
		resolvedRoot = root;
	}

	const modified: string[] = [];
	const added: string[] = [];
	const deleted: string[] = [];
	const lineCounts = new Map<string, { added: number; deleted: number }>();

	const diff = git(snapshot.cwd, ["diff", "--raw", "--numstat", "--no-renames", base, "--"]) ?? "";
	for (const line of diff.split("\n")) {
		if (line.startsWith(":")) {
			const [meta, file] = line.split("\t");
			const status = meta.split(" ")[4];
			if (status === "A") added.push(file);
			else if (status === "D") deleted.push(file);
			else modified.push(file);
		} else if (line) {
			const [a, d, file] = line.split("\t");
			// "-" marks a binary file: no line counts.
			lineCounts.set(file, { added: Number(a) || 0, deleted: Number(d) || 0 });
		}
	}

	// Untracked files are invisible to `git diff`; new ones are anything not already untracked at snapshot time.
	// `snapshot.untrackedFiles` may contain cwd-relative paths including sibling paths like `../../docs/scratch.txt`
	// (from repo-root enumeration) and raw UTF-8 non-ASCII filenames like `caf\u00e9.txt`. The priorUntracked Set
	// resolves both sibling `../` paths and UTF-8 filenames to canonical absolute paths matching resolve(resolvedRoot, file)
	// when `git status --porcelain -z --untracked-files=all` runs with `-c core.quotepath=false`.
	const priorUntracked = new Set(snapshot.untrackedFiles.map((file) => resolve(realCwd, file)));
	const status = git(snapshot.cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]) ?? "";
	for (const entry of status.split("\0")) {
		if (!entry.startsWith("?? ")) continue;
		const file = entry.slice(3);
		if (priorUntracked.has(resolve(resolvedRoot, file))) continue;
		added.push(file);
		lineCounts.set(file, { added: countFileLines(resolve(resolvedRoot, file)), deleted: 0 });
	}

	let totalAdded = 0;
	let totalDeleted = 0;
	for (const counts of lineCounts.values()) {
		totalAdded += counts.added;
		totalDeleted += counts.deleted;
	}

	const toRel = (file: string) => relative(realCwd, resolve(resolvedRoot, file));
	const report: ExecutionConsequenceReport = {
		cwd: snapshot.cwd,
		modifiedFiles: modified.map(toRel),
		addedFiles: added.map(toRel),
		deletedFiles: deleted.map(toRel),
		totalAddedLines: totalAdded,
		totalDeletedLines: totalDeleted,
		outOfScopeFiles: [],
		// Everything `git diff` reports as deleted existed in the snapshot base, so it was tracked.
		deletedTrackedFiles: deleted.map(toRel),
		summary: "",
		latencyMs: 0,
	};

	const scopeLock = guardPolicy?.scopeLock;
	if (scopeLock) {
		const lock = { ...scopeLock, cwd: scopeLock.cwd ?? snapshot.cwd };
		// A deleted file no longer exists, which checkScopeLock would misread as "creating a new file".
		const deleteLock = { ...lock, allowNewFiles: undefined };
		const outside = new Set<string>();
		for (const file of [...modified, ...added, ...deleted]) {
			const abs = resolve(resolvedRoot, file);
			const isDeleted = deleted.includes(file);
			const violation = checkScopeLock(abs, isDeleted ? deleteLock : lock);
			// checkScopeLock only sees pre-existing files, so a new file under allowNewFiles=false is checked here.
			const forbiddenNew = scopeLock.allowNewFiles === false && added.includes(file);
			if (violation || forbiddenNew) outside.add(toRel(file));
		}
		report.outOfScopeFiles = [...outside];
	}

	const total = modified.length + added.length + deleted.length;
	report.summary =
		total === 0
			? "No filesystem changes observed."
			: `${total} file(s) changed (${modified.length} modified, ${added.length} added, ${deleted.length} deleted), +${totalAdded}/-${totalDeleted} lines.`;
	report.latencyMs = elapsed(t0);
	return report;
}

/**
 * Decide whether the observed consequences are acceptable. Scope violations take precedence over budget ones.
 * Without a guard policy there is nothing to enforce, so the report is allowed.
 */
export function evaluateConsequencePolicy(
	report: ExecutionConsequenceReport,
	guardPolicy?: TaskGuardPolicy,
): ToolVerificationResult {
	if (report.outOfScopeFiles.length > 0) {
		const reason = `Observed changes outside TaskScopeLock: ${report.outOfScopeFiles.join(", ")} (${report.summary})`;
		return {
			allowed: false,
			decision: "block",
			code: "CONSEQUENCE_SCOPE_VIOLATION",
			reason,
			violations: report.outOfScopeFiles.map((file) => ({
				domain: "filesystem",
				rule: "consequence_scope_lock",
				target: file,
				explanation: reason,
			})),
		};
	}

	const budget = guardPolicy?.diffBudget;
	if (budget) {
		const files = report.modifiedFiles.length + report.addedFiles.length + report.deletedFiles.length;
		const changed = report.totalAddedLines + report.totalDeletedLines;
		const exceeded: string[] = [];
		if (budget.maxFiles !== undefined && files > budget.maxFiles)
			exceeded.push(`${files} files > maxFiles=${budget.maxFiles}`);
		if (budget.maxAddedLines !== undefined && report.totalAddedLines > budget.maxAddedLines) {
			exceeded.push(`${report.totalAddedLines} added lines > maxAddedLines=${budget.maxAddedLines}`);
		}
		if (budget.maxChangedLines !== undefined && changed > budget.maxChangedLines) {
			exceeded.push(`${changed} changed lines > maxChangedLines=${budget.maxChangedLines}`);
		}
		if (exceeded.length > 0) {
			const observed = [...report.modifiedFiles, ...report.addedFiles, ...report.deletedFiles].join(", ");
			const reason = `Observed changes exceed DiffBudget: ${exceeded.join("; ")}. Files: ${observed}`;
			return {
				allowed: false,
				decision: "block",
				code: "CONSEQUENCE_BUDGET_VIOLATION",
				reason,
				violations: [{ domain: "filesystem", rule: "consequence_diff_budget", explanation: reason }],
			};
		}
	}
	return { allowed: true, decision: "allow" };
}

function findRepoRoot(start: string): string | null {
	let dir = start;
	while (!existsSync(join(dir, ".git"))) {
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return dir;
}

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
		});
	} catch {
		return null;
	}
}

function countFileLines(file: string): number {
	try {
		const size = statSync(file).size;
		if (size === 0 || size > MAX_COUNT_BYTES) return 0;
		const buf = Buffer.alloc(size);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, size, 0);
		} finally {
			closeSync(fd);
		}
		if (buf.subarray(0, 8192).includes(0)) return 0;
		let lines = 0;
		for (const byte of buf) if (byte === 10) lines++;
		return buf[size - 1] === 10 ? lines : lines + 1;
	} catch {
		return 0;
	}
}

function elapsed(t0: number): number {
	return Math.round((performance.now() - t0) * 1000) / 1000;
}

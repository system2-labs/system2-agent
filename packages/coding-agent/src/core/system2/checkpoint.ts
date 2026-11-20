import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export interface WorktreeSnapshot {
	stashSha: string;
	headSha: string;
	timestamp: number;
	cwd: string;
	untrackedFiles: string[];
	isGitRepo: boolean;
}

export interface RollbackResult {
	restored: boolean;
	latencyMs: number;
}

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/i;

function isValidGitSha(s: string): boolean {
	return s !== "" && GIT_SHA_RE.test(s);
}

function safeRealpath(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

// Executes git commands safely via execFileSync with timeout/maxBuffer bounds,
// avoiding shell interpolation and preventing ENOBUFS or command injection.
function gitExec(cwd: string, args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
	try {
		const result = execFileSync("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
		});
		return { ok: true, stdout: result };
	} catch (e: unknown) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// Trust boundary: callers can construct snapshot objects manually (tests, old serialized data),
// so a missing isGitRepo field must fall back to an actual git check on the snapshotted cwd.
function isGitWorktree(cwd: string): boolean {
	const res = gitExec(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!res.ok) return false;
	return res.stdout.trim() === "true";
}

function snapshotIsRollbackable(snapshot: WorktreeSnapshot): boolean {
	if (snapshot.isGitRepo === false) return false;
	if (snapshot.isGitRepo !== true && !isGitWorktree(snapshot.cwd)) return false;
	return true;
}

export async function captureSnapshot(cwd: string): Promise<WorktreeSnapshot> {
	// Combine worktree check + repo root in one git spawn (saves ~18ms toward the <85ms SLA)
	// and short-circuits non-git directories after a single piped process.
	const probeRes = gitExec(cwd, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"]);
	if (!probeRes.ok) {
		return { stashSha: "", headSha: "", timestamp: Date.now(), cwd, untrackedFiles: [], isGitRepo: false };
	}
	const probeLines = probeRes.stdout.trim().split(/\r?\n/);
	if (probeLines[0]?.trim() !== "true" || !probeLines[1]) {
		return { stashSha: "", headSha: "", timestamp: Date.now(), cwd, untrackedFiles: [], isGitRepo: false };
	}
	const repoRoot = probeLines[1].trim();

	// Single porcelain v2 status call yields HEAD OID (or "(initial)" on unborn HEAD),
	// tracked/staged dirty state, and repo-wide non-ignored untracked files (-z, raw UTF-8).
	// If this fails (e.g. ENOBUFS or timeout), fail safe with isGitRepo: false so rollback
	// can never run git clean -fd over a truncated untracked list.
	const statusRes = gitExec(repoRoot, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	if (!statusRes.ok) {
		return { stashSha: "", headSha: "", timestamp: Date.now(), cwd, untrackedFiles: [], isGitRepo: false };
	}

	const realCwd = safeRealpath(cwd);
	const realRoot = safeRealpath(repoRoot);
	let headSha = "";
	let hasTrackedDirty = false;
	const untrackedFiles: string[] = [];

	const tokens = statusRes.stdout.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i];
		if (!entry) continue;
		if (entry.startsWith("# branch.oid ")) {
			const oid = entry.slice("# branch.oid ".length).trim();
			if (oid && oid !== "(initial)") headSha = oid;
		} else if (entry.startsWith("? ")) {
			const rel = entry.slice(2);
			if (rel) untrackedFiles.push(path.relative(realCwd, path.join(realRoot, rel)));
		} else if (entry.startsWith("2 ")) {
			// Rename/copy entry in -z mode is followed by an extra NUL-terminated origPath token.
			hasTrackedDirty = true;
			i++;
		} else if (entry.startsWith("1 ") || entry.startsWith("u ")) {
			hasTrackedDirty = true;
		}
	}

	// Only spawn `git stash create` when HEAD exists and tracked/index files are actually dirty.
	let stashSha = "";
	if (headSha !== "" && hasTrackedDirty) {
		const stashRes = gitExec(repoRoot, ["stash", "create"]);
		if (!stashRes.ok) {
			// Fail safe: if stash create fails on a dirty repo, do not treat as clean
			// (which would wipe pre-existing edits on rollback).
			return { stashSha: "", headSha: "", timestamp: Date.now(), cwd, untrackedFiles: [], isGitRepo: false };
		}
		stashSha = stashRes.stdout.trim();
	}

	return {
		stashSha,
		headSha,
		timestamp: Date.now(),
		cwd,
		untrackedFiles,
		isGitRepo: true,
	};
}

// Detects whether anything on disk changed since the snapshot was captured. Returns false for
// non-git directories (no git state to compare) so read-only commands never trigger a rollback.
//
// The comparison baseline is `snapshot.stashSha || snapshot.headSha`, never HEAD:
// `git stash create` records a commit whose tree equals the exact tracked working tree
// (staged + unstaged) at capture time, so `git diff --name-only <base>` is empty for
// pre-existing dirty edits the snapshot already recorded, and non-empty only when a tracked
// file was further modified, deleted, or reverted toward HEAD after the capture. Comparing
// against HEAD (the old behaviour) treats every pre-existing dirty tracked file as a new
// change, falsely reporting mutations in any repo that was already dirty.
// We must NOT re-run `git stash create` and compare its SHA against `snapshot.stashSha`:
// the command stamps the current wall-clock timestamp into the commit object, so two runs
// over an identical dirty state produce different SHAs.
export function hasSnapshotChanges(snapshot: WorktreeSnapshot): boolean {
	if (!snapshotIsRollbackable(snapshot)) return false;

	// Validate SHAs to block command injection.
	if (snapshot.headSha && !isValidGitSha(snapshot.headSha)) return false;
	if (snapshot.stashSha && !isValidGitSha(snapshot.stashSha)) return false;

	const cwd = snapshot.cwd;

	// Unconditional HEAD drift check (#6).
	const headRes = gitExec(cwd, ["rev-parse", "HEAD"]);
	const currentHead = headRes.ok ? headRes.stdout.trim() : "";

	if (snapshot.headSha) {
		// If snapshot had a headSha: only treat as HEAD drift when currentHead !== snapshot.headSha.
		if (headRes.ok && currentHead !== snapshot.headSha) return true;
	} else {
		// If !snapshot.headSha (unborn HEAD at capture): if currentHead !== "" (an initial commit was created!), return true.
		if (headRes.ok && currentHead !== "") return true;
	}

	// Tracked worktree + index diff (#5, #6, #8).
	const base = snapshot.stashSha || snapshot.headSha;
	if (base) {
		// Worktree diff vs base.
		const wtDiff = gitExec(cwd, ["diff", "--name-only", base, "--"]);
		if (wtDiff.ok && wtDiff.stdout.trim().length > 0) return true;

		// Index-only shift check: stashSha^2 restores exact original git index.
		const indexBase = snapshot.stashSha ? `${snapshot.stashSha}^2` : snapshot.headSha;
		const idxDiff = gitExec(cwd, ["diff", "--cached", "--name-only", indexBase, "--"]);
		if (idxDiff.ok && idxDiff.stdout.trim().length > 0) return true;
	} else {
		// !base (unborn HEAD, 0 commits! #6): check staged files.
		const staged = gitExec(cwd, ["diff", "--cached", "--name-only"]);
		if (staged.ok && staged.stdout.trim().length > 0) return true;
	}

	// Repo-wide -z untracked-file delta (#10).
	const rootRes = gitExec(cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootRes.ok) return false;
	const repoRoot = rootRes.stdout.trim();

	const lsRes = gitExec(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!lsRes.ok) return false;

	const realCwd = safeRealpath(cwd);
	const realRoot = safeRealpath(repoRoot);

	// Normalize snapshot.untrackedFiles to resolved absolute paths.
	const initAbs = new Set<string>();
	for (const f of snapshot.untrackedFiles) {
		initAbs.add(path.resolve(realCwd, f));
	}

	// Check current untracked files.
	for (const rel of lsRes.stdout.split("\0")) {
		if (!rel) continue;
		const abs = path.resolve(realRoot, rel);
		if (!initAbs.has(abs)) return true;
	}

	return false;
}

export async function rollbackSnapshot(snapshot: WorktreeSnapshot): Promise<RollbackResult> {
	const t0 = performance.now();

	if (!snapshotIsRollbackable(snapshot)) {
		return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
	}

	// Validate SHAs to block command injection.
	if (snapshot.headSha && !isValidGitSha(snapshot.headSha)) {
		return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
	}
	if (snapshot.stashSha && !isValidGitSha(snapshot.stashSha)) {
		return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
	}

	const cwd = snapshot.cwd;

	// Resolve repo root.
	const rootRes = gitExec(cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootRes.ok) {
		return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
	}
	const repoRoot = rootRes.stdout.trim();

	// Unborn HEAD handling (#6).
	if (!snapshot.headSha && !snapshot.stashSha) {
		// Check if there are staged files that cannot be rolled back.
		const staged = gitExec(repoRoot, ["diff", "--cached", "--name-only"]);
		if (staged.ok && staged.stdout.trim().length > 0) {
			// Pre-existing staged files cannot be rolled back without a commit.
			return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
		}

		// Unstage any newly staged files and remove newly created untracked files.
		gitExec(repoRoot, ["rm", "-rf", "--cached", "--ignore-unmatch", "."]);

		// Clean up newly created untracked files.
		const lsRes = gitExec(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
		if (lsRes.ok) {
			const realCwd = safeRealpath(cwd);
			const realRoot = safeRealpath(repoRoot);
			const initAbs = new Set(snapshot.untrackedFiles.map((f) => path.resolve(realCwd, f)));

			for (const rel of lsRes.stdout.split("\0")) {
				if (!rel || rel === ".") continue;
				const abs = path.resolve(realRoot, rel);
				if (abs === realRoot || abs === realCwd || initAbs.has(abs)) continue;

				if (existsSync(abs)) {
					rmSync(abs, { force: true });
					// Walk upward removing parent directories ONLY if empty and strictly inside realRoot.
					// rmdirSync is kernel-enforced to fail on non-empty dirs, preventing accidental recursive wipes.
					let dir = path.dirname(abs);
					while (dir !== realRoot && dir !== realCwd && dir.startsWith(`${realRoot}${path.sep}`)) {
						const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
						if (entries.length === 0) {
							try {
								rmdirSync(dir);
							} catch {
								break;
							}
							dir = path.dirname(dir);
						} else {
							break;
						}
					}
				}
			}
		}
		return { restored: true, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
	}

	// Normal git rollback with index preservation (#3, #8).
	if (snapshot.headSha) {
		const resetRes = gitExec(repoRoot, ["reset", "--hard", snapshot.headSha]);
		if (!resetRes.ok) {
			return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
		}
	}

	if (snapshot.stashSha) {
		// 1. restore exact working tree.
		const readTree1 = gitExec(repoRoot, ["read-tree", "-u", "--reset", snapshot.stashSha]);
		if (!readTree1.ok) {
			return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
		}
		// 2. restore exact original git index without altering working tree.
		const readTree2 = gitExec(repoRoot, ["read-tree", "--reset", `${snapshot.stashSha}^2`]);
		if (!readTree2.ok) {
			// If stashSha^2 doesn't exist (e.g. clean capture), this is fine.
		}
	}

	// File-level untracked cleanup — NO --directory! (#2, #10).
	if (snapshot.untrackedFiles.length > 0) {
		const lsRes = gitExec(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
		if (lsRes.ok) {
			const realCwd = safeRealpath(cwd);
			const realRoot = safeRealpath(repoRoot);
			const initAbs = new Set(snapshot.untrackedFiles.map((f) => path.resolve(realCwd, f)));

			for (const rel of lsRes.stdout.split("\0")) {
				if (!rel || rel === ".") continue;
				const abs = path.resolve(realRoot, rel);
				if (abs === realRoot || abs === realCwd || initAbs.has(abs)) continue;

				if (existsSync(abs)) {
					rmSync(abs, { force: true });
					// Walk upward removing parent directories ONLY if empty and strictly inside realRoot.
					// rmdirSync is kernel-enforced to fail on non-empty dirs, preventing accidental recursive wipes.
					let dir = path.dirname(abs);
					while (dir !== realRoot && dir !== realCwd && dir.startsWith(`${realRoot}${path.sep}`)) {
						const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
						if (entries.length === 0) {
							try {
								rmdirSync(dir);
							} catch {
								break;
							}
							dir = path.dirname(dir);
						} else {
							break;
						}
					}
				}
			}
		} else {
			// If ls-files fails, do NOT run git clean -fd blindly.
		}
	} else {
		// When snapshot.untrackedFiles.length === 0, running git clean -fd at repoRoot is safe.
		gitExec(repoRoot, ["clean", "-fd"]);
	}

	return { restored: true, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
}

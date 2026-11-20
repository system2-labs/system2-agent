import { execFileSync, execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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

// Trust boundary: callers can construct snapshot objects manually (tests, old serialized data),
// so a missing isGitRepo field must fall back to an actual git check on the snapshotted cwd.
// stdio is piped (not inherited) so a `fatal: not a git repository` message from git in a
// non-worktree directory does not leak into the TUI's stderr.
function isGitWorktree(cwd: string): boolean {
	try {
		return (
			execSync("git rev-parse --is-inside-work-tree", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim() === "true"
		);
	} catch {
		return false;
	}
}

function snapshotIsRollbackable(snapshot: WorktreeSnapshot): boolean {
	if (snapshot.isGitRepo === false) return false;
	if (!snapshot.headSha && !snapshot.stashSha && !isGitWorktree(snapshot.cwd)) return false;
	return true;
}

export async function captureSnapshot(cwd: string): Promise<WorktreeSnapshot> {
	const run = (cmd: string) => {
		try {
			return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		} catch {
			return "";
		}
	};
	return {
		stashSha: run("git stash create"),
		headSha: run("git rev-parse HEAD"),
		timestamp: Date.now(),
		cwd,
		untrackedFiles: run("git ls-files --others --exclude-standard").split("\n").filter(Boolean),
		isGitRepo: isGitWorktree(cwd),
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
// `execFileSync` (no shell) is used for the SHA-bearing diff to avoid shell interpolation
// of a value read from the snapshot object.
export function hasSnapshotChanges(snapshot: WorktreeSnapshot): boolean {
	if (!snapshotIsRollbackable(snapshot)) return false;
	const cwd = snapshot.cwd;
	const run = (cmd: string) => {
		try {
			return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		} catch {
			return "";
		}
	};
	// HEAD moved (commit, checkout, reset, rebase) since the snapshot: definitely changed.
	if (snapshot.headSha && run("git rev-parse HEAD") !== snapshot.headSha) return true;
	// Tracked-file diff against the snapshot's own tree; a missing stashSha (clean capture)
	// falls back to headSha, which is the same tree.
	const base = snapshot.stashSha || snapshot.headSha;
	if (!base) return false;
	if (
		execFileSync("git", ["diff", "--name-only", base, "--"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim().length > 0
	) {
		return true;
	}
	// Untracked-file delta: any untracked file now present that the snapshot did not record.
	const current = new Set(run("git ls-files --others --exclude-standard").split("\n").filter(Boolean));
	for (const file of snapshot.untrackedFiles) {
		current.delete(file);
	}
	return current.size > 0;
}

export async function rollbackSnapshot(snapshot: WorktreeSnapshot): Promise<RollbackResult> {
	const t0 = performance.now();
	if (!snapshotIsRollbackable(snapshot)) {
		return { restored: false, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
	}
	const cwd = snapshot.cwd;
	const run = (cmd: string) => execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	if (snapshot.headSha) run(`git reset --hard ${snapshot.headSha}`);
	if (snapshot.stashSha) run(`git read-tree -u --reset ${snapshot.stashSha}`);
	if (snapshot.untrackedFiles.length === 0) {
		run("git clean -fd");
	} else {
		const init = new Set(snapshot.untrackedFiles);
		try {
			// Piped stdio: same stderr-leak protection as isGitWorktree.
			const files = execSync("git ls-files --others --exclude-standard --directory", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			})
				.trim()
				.split("\n")
				.filter(Boolean);
			for (const rel of files) {
				const n = rel.endsWith("/") ? rel.slice(0, -1) : rel;
				if (!init.has(rel) && !init.has(n) && existsSync(path.join(cwd, n)))
					rmSync(path.join(cwd, n), { recursive: true, force: true });
			}
		} catch {}
	}
	return { restored: true, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
}

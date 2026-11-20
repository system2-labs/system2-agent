import { execSync } from "node:child_process";
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
function isGitWorktree(cwd: string): boolean {
	try {
		return execSync("git rev-parse --is-inside-work-tree", { cwd, encoding: "utf-8" }).trim() === "true";
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
	if (run("git diff --name-only HEAD").length > 0) return true;
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
			const files = execSync("git ls-files --others --exclude-standard --directory", { cwd, encoding: "utf-8" })
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

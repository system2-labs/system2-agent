import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureSnapshot, hasSnapshotChanges, rollbackSnapshot } from "../src/core/system2/checkpoint.ts";

describe("system2 checkpoint engine", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "s2-cp-test-"));
		execSync("git init -b main && git config user.name T && git config user.email t@t.com", { cwd: dir });
		writeFileSync(join(dir, "f.txt"), "v1\n");
		execSync("git add f.txt && git commit -m c", { cwd: dir });
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("snapshot: captures atomic worktree in < 85ms without altering working tree", async () => {
		writeFileSync(join(dir, "f.txt"), "v2\n");
		writeFileSync(join(dir, "u.txt"), "u\n");
		const statusBefore = execSync("git status --porcelain", { cwd: dir }).toString();
		const t0 = performance.now();
		const snap = await captureSnapshot(dir);
		expect(performance.now() - t0).toBeLessThan(85);
		expect(snap.headSha).toBeTruthy();
		expect(snap.stashSha).toBeTruthy();
		expect(snap.untrackedFiles).toContain("u.txt");
		expect(execSync("git status --porcelain", { cwd: dir }).toString()).toBe(statusBefore);
		expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("v2\n");
	});

	it("rollback: restores exact clean state via git reset and clean with zero residual dirty files", async () => {
		const snap = await captureSnapshot(dir);
		expect(snap.stashSha).toBe("");
		writeFileSync(join(dir, "f.txt"), "bad\n");
		writeFileSync(join(dir, "g.txt"), "g\n");
		const res = await rollbackSnapshot(snap);
		expect(res.restored).toBe(true);
		expect(res.latencyMs).toBeLessThan(85);
		expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("v1\n");
		expect(existsSync(join(dir, "g.txt"))).toBe(false);
		expect(execSync("git status --porcelain", { cwd: dir }).toString().trim()).toBe("");
	});

	it("rollback: restores exact dirty state via git read-tree without residue", async () => {
		writeFileSync(join(dir, "f.txt"), "v2\n");
		writeFileSync(join(dir, "u.txt"), "u\n");
		const snap = await captureSnapshot(dir);
		writeFileSync(join(dir, "f.txt"), "broken\n");
		writeFileSync(join(dir, "b.tmp"), "b\n");
		expect((await rollbackSnapshot(snap)).restored).toBe(true);
		expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("v2\n");
		expect(existsSync(join(dir, "u.txt"))).toBe(true);
		expect(existsSync(join(dir, "b.tmp"))).toBe(false);
	});

	it("rollback: manual snapshots without isGitRepo fall back to live git check", async () => {
		writeFileSync(join(dir, "u.txt"), "untracked\n");
		const legacy = { stashSha: "", headSha: "", timestamp: 0, cwd: dir, untrackedFiles: [] };
		expect((await rollbackSnapshot(legacy as any)).restored).toBe(true);
		expect(existsSync(join(dir, "u.txt"))).toBe(false);

		const nongit = { stashSha: "", headSha: "", timestamp: 0, cwd: dir, untrackedFiles: [], isGitRepo: false };
		expect((await rollbackSnapshot(nongit)).restored).toBe(false);
	});

	it("captureSnapshot in non-git temp dir sets isGitRepo false", async () => {
		const plain = mkdtempSync(join(tmpdir(), "s2-cp-nongit-"));
		try {
			writeFileSync(join(plain, "a.txt"), "hello\n");
			const snap = await captureSnapshot(plain);
			expect(snap.isGitRepo).toBe(false);
			expect(snap.headSha).toBe("");
			expect(snap.stashSha).toBe("");
			expect(snap.untrackedFiles).toEqual([]);
			expect(hasSnapshotChanges(snap)).toBe(false);

			writeFileSync(join(plain, "b.txt"), "new\n");
			const res = await rollbackSnapshot(snap);
			expect(res.restored).toBe(false);
			expect(res.latencyMs).toBeLessThan(50);
			// No git clean/reset ran: both files untouched.
			expect(readFileSync(join(plain, "a.txt"), "utf-8")).toBe("hello\n");
			expect(readFileSync(join(plain, "b.txt"), "utf-8")).toBe("new\n");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("non-git dir: capture/hasChanges/rollback run with zero stderr", () => {
		const plain = mkdtempSync(join(tmpdir(), "s2-cp-stderr-"));
		try {
			writeFileSync(join(plain, "a.txt"), "hello\n");
			const script = `
import { captureSnapshot, hasSnapshotChanges, rollbackSnapshot } from "${
				pathToFileURL(resolve(import.meta.dirname, "../src/core/system2/checkpoint.ts")).href
			}";
import { writeFileSync } from "node:fs";
const snap = await captureSnapshot(${JSON.stringify(plain)});
hasSnapshotChanges(snap);
writeFileSync(${JSON.stringify(join(plain, "b.txt"))}, "new\\n");
await rollbackSnapshot(snap);
`;
			// spawnSync so git's stderr (if the piped-stdio guard regressed) is captured on
			// the child instead of leaking to the test runner's own stderr.
			const proc = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8" });
			expect(proc.status).toBe(0);
			expect(proc.stderr).toBe("");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("hasSnapshotChanges detects tracked and untracked edits in a git repo", async () => {
		const snap = await captureSnapshot(dir);
		expect(hasSnapshotChanges(snap)).toBe(false);

		writeFileSync(join(dir, "f.txt"), "v2\n");
		expect(hasSnapshotChanges(snap)).toBe(true);

		writeFileSync(join(dir, "f.txt"), "v1\n");
		expect(hasSnapshotChanges(snap)).toBe(false);

		writeFileSync(join(dir, "x.tmp"), "x\n");
		expect(hasSnapshotChanges(snap)).toBe(true);
	});

	it("hasSnapshotChanges ignores pre-existing dirty tracked edits and pre-existing untracked files", async () => {
		// Dirty state the snapshot must absorb: an unstaged tracked edit plus a pre-existing untracked file.
		writeFileSync(join(dir, "f.txt"), "dirty-before\n");
		writeFileSync(join(dir, "pre.txt"), "pre\n");
		const snap = await captureSnapshot(dir);
		expect(hasSnapshotChanges(snap)).toBe(false);

		// Further modification after the capture: a real change.
		writeFileSync(join(dir, "f.txt"), "dirty-after\n");
		expect(hasSnapshotChanges(snap)).toBe(true);

		// Restoring the exact pre-capture content: back to the snapshot baseline.
		writeFileSync(join(dir, "f.txt"), "dirty-before\n");
		expect(hasSnapshotChanges(snap)).toBe(false);

		// Reverting toward HEAD: differs from the snapshot tree, still a change.
		writeFileSync(join(dir, "f.txt"), "v1\n");
		expect(hasSnapshotChanges(snap)).toBe(true);

		// New untracked file after the capture: a change.
		writeFileSync(join(dir, "f.txt"), "dirty-before\n");
		writeFileSync(join(dir, "extra.tmp"), "extra\n");
		expect(hasSnapshotChanges(snap)).toBe(true);

		// HEAD advanced since the snapshot: a change even with the working tree at baseline.
		rmSync(join(dir, "extra.tmp"));
		execSync("git commit --allow-empty -m bump", { cwd: dir });
		expect(hasSnapshotChanges(snap)).toBe(true);
	});

	it("hasSnapshotChanges ignores pre-existing staged edits until the file is modified after capture", async () => {
		// Staged dirty edit at capture time; the stash tree includes it.
		writeFileSync(join(dir, "f.txt"), "staged\n");
		execSync("git add f.txt", { cwd: dir });
		const snap = await captureSnapshot(dir);
		expect(hasSnapshotChanges(snap)).toBe(false);

		writeFileSync(join(dir, "f.txt"), "staged-again\n");
		expect(hasSnapshotChanges(snap)).toBe(true);
	});

	it("rollback: preserves pre-existing untracked directories while removing newly created untracked files", async () => {
		// Create a pre-existing untracked subdirectory with file.
		const nestedDir = join(dir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "keep.txt"), "keep\n");

		const snap = await captureSnapshot(dir);
		expect(snap.untrackedFiles).toContain("nested/keep.txt");

		// Create new untracked files: one in nested subdir, one in newdir.
		writeFileSync(join(dir, "nested", "bad.tmp"), "bad\n");
		const newdir = join(dir, "newdir");
		mkdirSync(newdir, { recursive: true });
		writeFileSync(join(newdir, "drop.tmp"), "drop\n");

		const res = await rollbackSnapshot(snap);
		expect(res.restored).toBe(true);

		// Pre-existing untracked directory should survive.
		expect(existsSync(join(nestedDir, "keep.txt"))).toBe(true);

		// New untracked files and newly-emptied dir should be removed.
		expect(existsSync(join(dir, "nested", "bad.tmp"))).toBe(false);
		expect(existsSync(newdir)).toBe(false);

		// Untracked subdir as cwd must never delete cwd itself on rollback.
		const subCwd = join(dir, "untracked-sub");
		mkdirSync(subCwd, { recursive: true });
		writeFileSync(join(subCwd, "stay.txt"), "stay\n");
		const subSnap = await captureSnapshot(subCwd);
		writeFileSync(join(subCwd, "gone.tmp"), "gone\n");
		expect((await rollbackSnapshot(subSnap)).restored).toBe(true);
		expect(existsSync(join(subCwd, "stay.txt"))).toBe(true);
		expect(existsSync(join(subCwd, "gone.tmp"))).toBe(false);
	});

	it("rollback: rejects crafted headSha/stashSha with shell metacharacters or leading flags", async () => {
		const realHead = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		const craftedSnap = {
			stashSha: `${realHead}; touch /tmp/s2-injected-stash`,
			headSha: `${realHead}; touch /tmp/s2-injected-head`,
			timestamp: Date.now(),
			cwd: dir,
			untrackedFiles: [],
			isGitRepo: true,
		};

		// hasSnapshotChanges should return false for crafted SHAs.
		expect(hasSnapshotChanges(craftedSnap)).toBe(false);

		// rollbackSnapshot should return restored: false for crafted SHAs.
		const res = await rollbackSnapshot(craftedSnap);
		expect(res.restored).toBe(false);

		// Also reject leading '-' git flag injection in base SHA.
		const flagSnap = {
			stashSha: "--output=/tmp/s2-flag-pwn",
			headSha: realHead,
			timestamp: Date.now(),
			cwd: dir,
			untrackedFiles: [],
			isGitRepo: true,
		};
		expect(hasSnapshotChanges(flagSnap)).toBe(false);
		expect((await rollbackSnapshot(flagSnap)).restored).toBe(false);

		// Verify no injection occurred.
		expect(existsSync("/tmp/s2-injected-stash")).toBe(false);
		expect(existsSync("/tmp/s2-injected-head")).toBe(false);
		expect(existsSync("/tmp/s2-flag-pwn")).toBe(false);
	});

	it("hasSnapshotChanges: does not throw when stashSha is pruned via git gc --prune=now", async () => {
		writeFileSync(join(dir, "f.txt"), "v2\n");
		const snap = await captureSnapshot(dir);

		// Prune the stash commit.
		execSync("git gc --prune=now", { cwd: dir });

		// hasSnapshotChanges should not throw when stashSha is pruned.
		expect(() => hasSnapshotChanges(snap)).not.toThrow();

		// Should return false since the tracked file is back to v1.
		writeFileSync(join(dir, "f.txt"), "v1\n");
		expect(hasSnapshotChanges(snap)).toBe(false);
	});

	it("unborn HEAD (0 commits): capture/hasChanges/rollback handle correctly", async () => {
		const unbornDir = mkdtempSync(join(tmpdir(), "s2-cp-unborn-"));
		const unbornStagedDir = mkdtempSync(join(tmpdir(), "s2-cp-unborn-staged-"));
		try {
			execSync("git init -b main && git config user.name T && git config user.email t@t.com", { cwd: unbornDir });
			writeFileSync(join(unbornDir, "keep.txt"), "keep\n");

			// Capture on 0-commit repo (unborn HEAD).
			const snap = await captureSnapshot(unbornDir);
			expect(snap.isGitRepo).toBe(true);
			expect(snap.headSha).toBe("");
			expect(snap.stashSha).toBe("");
			expect(hasSnapshotChanges(snap)).toBe(false);

			// New untracked file should be detected and cleaned by rollbackSnapshot while keeping keep.txt.
			writeFileSync(join(unbornDir, "extra.txt"), "extra\n");
			expect(hasSnapshotChanges(snap)).toBe(true);
			const res = await rollbackSnapshot(snap);
			expect(res.restored).toBe(true);
			expect(existsSync(join(unbornDir, "extra.txt"))).toBe(false);
			expect(existsSync(join(unbornDir, "keep.txt"))).toBe(true);

			// Stage a file and commit it (creates initial commit -> HEAD drift).
			writeFileSync(join(unbornDir, "init.txt"), "init\n");
			execSync("git add init.txt", { cwd: unbornDir });
			expect(hasSnapshotChanges(snap)).toBe(true);
			execSync("git commit -m initial", { cwd: unbornDir });
			expect(hasSnapshotChanges(snap)).toBe(true);

			// Pre-existing staged files in a separate 0-commit repo cannot be rolled back cleanly.
			execSync("git init -b main && git config user.name T && git config user.email t@t.com", {
				cwd: unbornStagedDir,
			});
			writeFileSync(join(unbornStagedDir, "pre.txt"), "pre\n");
			execSync("git add pre.txt", { cwd: unbornStagedDir });

			const snapStaged = await captureSnapshot(unbornStagedDir);
			expect(snapStaged.headSha).toBe("");
			expect(snapStaged.stashSha).toBe("");
			const resStaged = await rollbackSnapshot(snapStaged);
			expect(resStaged.restored).toBe(false);
		} finally {
			rmSync(unbornDir, { recursive: true, force: true });
			rmSync(unbornStagedDir, { recursive: true, force: true });
		}
	});

	it("rollbackSnapshot: preserves unstaged ' M f.txt' vs staged 'M  g.txt' index status via stashSha^2", async () => {
		writeFileSync(join(dir, "g.txt"), "v1\n");
		execSync("git add g.txt && git commit -m add-g", { cwd: dir });

		writeFileSync(join(dir, "f.txt"), "dirty\n");
		writeFileSync(join(dir, "g.txt"), "staged-content\n");
		execSync("git add g.txt", { cwd: dir });

		const snap = await captureSnapshot(dir);
		expect(snap.stashSha).toBeTruthy();

		// Modify f.txt (unstaged) and g.txt (staged) after capture.
		writeFileSync(join(dir, "f.txt"), "new-dirty\n");
		writeFileSync(join(dir, "g.txt"), "new-staged-content\n");

		const res = await rollbackSnapshot(snap);
		expect(res.restored).toBe(true);

		// Verify index status is preserved: f.txt should be " M f.txt" (unstaged), g.txt should be "M  g.txt" (staged).
		const status = execSync("git status --porcelain", { cwd: dir }).toString().trimEnd();
		const lines = status.split("\n");
		expect(lines).toContain(" M f.txt");
		expect(lines).toContain("M  g.txt");
	});

	it("hasSnapshotChanges: detects staging an already-dirty tracked file", async () => {
		writeFileSync(join(dir, "f.txt"), "dirty\n");
		const snap = await captureSnapshot(dir);

		// Stage the dirty file.
		execSync("git add f.txt", { cwd: dir });

		// Staging an already-dirty tracked file should be detected as a change.
		expect(hasSnapshotChanges(snap)).toBe(true);
	});

	it("rollback: handles subdirectory cwd + non-ASCII untracked filename (café.txt) cleanly", async () => {
		const subDir = join(dir, "subdir");
		mkdirSync(subDir, { recursive: true });
		// Pre-existing sibling untracked file outside subDir must be recorded relative to cwd.
		writeFileSync(join(dir, "sibling.txt"), "sib\n");
		const cafeFile = join(subDir, "café.txt");
		writeFileSync(cafeFile, "café content\n");

		const snap = await captureSnapshot(subDir);
		expect(snap.untrackedFiles).toContain("café.txt");
		expect(snap.untrackedFiles).toContain("../sibling.txt");
		expect(hasSnapshotChanges(snap)).toBe(false);

		// Add a new untracked file in subdir and outside subdir.
		writeFileSync(join(subDir, "new.txt"), "new\n");
		expect(hasSnapshotChanges(snap)).toBe(true);

		const res = await rollbackSnapshot(snap);
		expect(res.restored).toBe(true);

		// Pre-existing non-ASCII and sibling untracked files should be preserved.
		expect(existsSync(cafeFile)).toBe(true);
		expect(existsSync(join(dir, "sibling.txt"))).toBe(true);

		// New untracked file should be removed.
		expect(existsSync(join(subDir, "new.txt"))).toBe(false);
	});

	it("rollbackSnapshot: manual snapshot omitting isGitRepo with non-empty headSha pointing to non-git dir returns restored: false", async () => {
		const nongitDir = mkdtempSync(join(tmpdir(), "s2-cp-nongit-headSha-"));
		try {
			writeFileSync(join(nongitDir, "a.txt"), "hello\n");

			const fakeSnap = {
				stashSha: "",
				headSha: "abcdef1234567890abcdef1234567890abcdef12",
				timestamp: Date.now(),
				cwd: nongitDir,
				untrackedFiles: [],
			} as unknown as Parameters<typeof rollbackSnapshot>[0];

			const res = await rollbackSnapshot(fakeSnap);
			expect(res.restored).toBe(false);
		} finally {
			rmSync(nongitDir, { recursive: true, force: true });
		}
	});
});

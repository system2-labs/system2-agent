import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

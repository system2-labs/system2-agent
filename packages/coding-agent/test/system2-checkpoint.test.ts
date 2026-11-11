import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureSnapshot, rollbackSnapshot } from "../src/core/system2/checkpoint.ts";

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
});

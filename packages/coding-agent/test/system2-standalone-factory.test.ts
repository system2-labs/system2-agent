import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFactoryCliCommand } from "../src/core/system2/factory-cli.ts";
import { appendReverieBlockToFile, mintReverieBlock } from "../src/core/system2/reverie-ledger.ts";
import {
	auditRepoSecretsAndPii,
	parseSpecToml,
	planStandaloneFactoryRun,
	runNativeSpecVerify,
} from "../src/core/system2/standalone-factory.ts";

describe("S2-FAC-09: Standalone System 2 Software Factory Product", () => {
	it("parses spec.toml and executes runNativeSpecVerify without external Python verify.py", () => {
		const tmp = mkdtempSync(join(tmpdir(), "s2-standalone-verify-"));
		try {
			const specToml = [
				'ticket = "S2-TEST-01"',
				'slug = "S2-TEST-01-native"',
				'title = "feat(standalone): native typescript spec verifier"',
				"size_cap = 250",
				"",
				"[split]",
				'step = "step 1 of 1"',
				"",
				"external = []",
				"",
				"[[acceptance]]",
				'name = "unit_check"',
				'criterion = "Deterministic check passes"',
				'command = "echo ok"',
				"",
				"[expected]",
				'plan = "Verify natively in TS"',
				"line_count = 120",
				"",
				"[pr]",
				'why = "Remove external Python verify.py dependency for npm global installs"',
				'merge_effect = "Self-contained verification"',
				'rollback = "git revert HEAD"',
				'out_of_scope = "Docker sidecars"',
			].join("\n");

			const parsed = parseSpecToml(specToml);
			expect(parsed.ticket).toBe("S2-TEST-01");
			expect(parsed.sizeCap).toBe(250);
			expect(parsed.acceptance).toHaveLength(1);
			expect(parsed.acceptance[0].name).toBe("unit_check");

			const specPath = join(tmp, "spec.toml");
			writeFileSync(specPath, specToml, "utf8");

			const res = runNativeSpecVerify(specPath, tmp, () => ({
				code: 0,
				output: "1 file changed, 20 insertions(+)",
			}));
			expect(res.passed).toBe(true);
			expect(res.results[0].passed).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("plans standalone worktree waves with lean pi flags (--no-skills --no-context-files) and safe VRAM caps", () => {
		const plan = planStandaloneFactoryRun({
			goal: "Add standalone runner",
			modelId: "thinkingmachines/inkling-2-mini",
			requestedContextLength: 1048576,
			cards: [
				{
					id: "S2-CARD-01",
					title: "Core module",
					allowedFiles: ["src/a.ts"],
					maxChangedLines: 150,
					verifyCmd: "npx vitest run",
					dependsOn: [],
				},
				{
					id: "S2-CARD-02",
					title: "Dependent module",
					allowedFiles: ["src/b.ts"],
					maxChangedLines: 150,
					verifyCmd: "npx vitest run",
					dependsOn: ["S2-CARD-01"],
				},
			],
		});

		expect(plan.vramLoadPlan.oversubscriptionPrevented).toBe(true);
		expect(plan.vramLoadPlan.selectedContextLength).toBeLessThanOrEqual(65536);
		expect(plan.vramLoadPlan.selectedParallel).toBe(1);
		expect(plan.waves).toHaveLength(2);
		expect(plan.waves[0][0].leanPiArgs).toContain("--no-skills");
		expect(plan.waves[0][0].leanPiArgs).toContain("--no-context-files");
		expect(plan.waves[0][0].leanPiArgs).toContain("--no-session");
	});

	it("detects leaked API keys, hardcoded personal home paths, and .gitignore gaps in auditRepoSecretsAndPii", () => {
		const fakeOpenAiKey = ["sk-proj", "1234567890abcdefghijklmnopQRSTUV"].join("-");
		const fakeHomePath = ["/Users", "johndoe", "secret-repo/config.ts"].join("/");
		const dirtyAudit = auditRepoSecretsAndPii({
			gitignoreContent: "node_modules\ndist/\n",
			files: [
				{
					path: "src/leak.ts",
					content: `const key = "${fakeOpenAiKey}";\nconst p = "${fakeHomePath}";`,
					isTest: false,
				},
			],
		});

		expect(dirtyAudit.clean).toBe(false);
		expect(dirtyAudit.findings.some((f) => f.rule === "openai_or_anthropic_key")).toBe(true);
		expect(dirtyAudit.findings.some((f) => f.rule === "hardcoded_user_home_path")).toBe(true);
		expect(dirtyAudit.findings.some((f) => f.rule === "missing_gitignore_guard")).toBe(true);

		const cleanAudit = auditRepoSecretsAndPii({
			gitignoreContent: "node_modules\n.env\n.system2/\n",
			files: [{ path: "src/clean.ts", content: 'export const APP = "system2";\n', isTest: false }],
		});
		expect(cleanAudit.clean).toBe(true);
		expect(cleanAudit.findings).toHaveLength(0);
	});

	it("wires verify, run, reverie, arena, and audit-secrets subcommands into system2 factory CLI", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "s2-cli-subcommands-"));
		try {
			writeFileSync(join(tmp, ".gitignore"), "node_modules\n.env\n.system2/\n", "utf8");
			writeFileSync(join(tmp, "app.ts"), "export const x = 1;\n", "utf8");

			const chainPath = join(tmp, ".system2", "reverie.chain.jsonl");
			const b0 = mintReverieBlock({
				proofOfWork: { ticketSlug: "S2-FAC-09", commitSha: "a1b2c3d4", verifyPassedRound: 1, docsUpdated: true },
				origin: { engine: "pi-system2", persona: "Philosopher", sessionId: "sess-cli-1" },
				payload: { kind: "open_forum", title: "Standalone CLI", pitch: "Native verify and wave runner" },
			});
			appendReverieBlockToFile(chainPath, b0);

			const logs: string[] = [];
			const ctx = { cwd: tmp, stdout: (t: string) => logs.push(t), stderr: (t: string) => logs.push(t) };

			const revCode = await runFactoryCliCommand(["reverie", "list", "--json"], ctx);
			expect(revCode).toBe(0);
			expect(JSON.parse(logs.pop() ?? "{}").blockCount).toBe(1);

			const arenaCode = await runFactoryCliCommand(["arena", "thinkingmachines/inkling-2-mini", "--json"], ctx);
			expect(arenaCode).toBe(0);
			expect(JSON.parse(logs.pop() ?? "{}").loadPlan.selectedParallel).toBe(1);

			const runCode = await runFactoryCliCommand(["run", "--json"], ctx);
			expect(runCode).toBe(0);
			expect(JSON.parse(logs.pop() ?? "{}").vramLoadPlan.safeToLoad).toBe(true);

			const auditCode = await runFactoryCliCommand(["audit-secrets", "--json"], ctx);
			expect(auditCode).toBe(0);
			expect(JSON.parse(logs.pop() ?? "{}").clean).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

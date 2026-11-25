import { describe, expect, it } from "vitest";
import {
	auditSystem2HookFootprint,
	classifyUpstreamCommit,
	DEFAULT_SYSTEM2_HOOK_FILES,
	filterMeaningfulUpstreamCommits,
	parseGitDiffNumstat,
	planUpstreamSyncWaves,
	renderUpstreamSyncSpecToml,
	resolveSystem2ExecutionMode,
	type UpstreamCommitInput,
} from "../src/core/system2/upstream-sync.ts";

describe("classifyUpstreamCommit & filterMeaningfulUpstreamCommits", () => {
	it("classifies security, provider_update, durable_session, core_bugfix, and cosmetic_or_docs commits", () => {
		const sec = classifyUpstreamCommit({
			sha: "a111111",
			subject: "fix(security): sanitize shell args to prevent CVE-2026-1042 command injection",
			files: ["packages/coding-agent/src/core/bash-executor.ts"],
			linesChanged: 34,
		});
		expect(sec.category).toBe("security");
		expect(sec.collisionRisk).toBe("none");
		expect(sec.recommended).toBe(true);

		const provider = classifyUpstreamCommit({
			sha: "b222222",
			subject: "feat(ai): update Anthropic Claude 4.6 and Gemini thinking catalog token limits",
			files: ["packages/ai/src/providers/anthropic.ts", "packages/ai/catalog/models.json"],
			linesChanged: 58,
		});
		expect(provider.category).toBe("provider_update");
		expect(provider.collisionRisk).toBe("none");
		expect(provider.recommended).toBe(true);

		const session = classifyUpstreamCommit({
			sha: "c333333",
			subject: "fix(session): ensure durable JSONL checkpoint flush on unexpected compaction abort",
			files: ["packages/coding-agent/src/core/session-manager.ts"],
			linesChanged: 42,
		});
		expect(session.category).toBe("durable_session");
		expect(session.recommended).toBe(true);

		const bugfix = classifyUpstreamCommit({
			sha: "d444444",
			subject: "fix(tui): resolve race condition on terminal resize event listener",
			files: ["packages/tui/src/terminal.ts"],
			linesChanged: 19,
		});
		expect(bugfix.category).toBe("core_bugfix");
		expect(bugfix.recommended).toBe(true);

		const docs = classifyUpstreamCommit({
			sha: "e555555",
			subject: "docs(readme): fix typo in keybinding table",
			files: ["README.md", "docs/keybindings.md"],
			linesChanged: 6,
		});
		expect(docs.category).toBe("cosmetic_or_docs");
		expect(docs.recommended).toBe(false);
	});

	it("detects hook_boundary collision risk on config.ts, interactive-mode.ts, and slash-commands.ts", () => {
		const hookCommit = classifyUpstreamCommit({
			sha: "f666666",
			subject: "fix(cli): handle missing settings file in config loader and interactive mode",
			files: [
				"packages/coding-agent/src/config.ts",
				"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
			],
			linesChanged: 28,
		});
		expect(hookCommit.collisionRisk).toBe("hook_boundary");
		expect(hookCommit.collidingFiles).toEqual([
			"packages/coding-agent/src/config.ts",
			"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		]);
		expect(DEFAULT_SYSTEM2_HOOK_FILES).toContain("packages/coding-agent/src/core/slash-commands.ts");
	});

	it("detects direct_conflict when an upstream commit touches src/core/system2/** or explicit directConflictFiles", () => {
		const directCommit = classifyUpstreamCommit({
			sha: "7777777",
			subject: "feat: conflicting experimental module",
			files: ["packages/coding-agent/src/core/system2/policy.ts", "packages/coding-agent/src/config.ts"],
			linesChanged: 40,
		});
		expect(directCommit.collisionRisk).toBe("direct_conflict");
		expect(directCommit.collidingFiles[0]).toBe("packages/coding-agent/src/core/system2/policy.ts");
	});

	it("filters out cosmetic_or_docs commits and optionally direct conflicts", () => {
		const commits: UpstreamCommitInput[] = [
			{
				sha: "101",
				subject: "docs: update changelog",
				files: ["CHANGELOG.md"],
				linesChanged: 12,
			},
			{
				sha: "102",
				subject: "fix(security): harden oauth token permissions",
				files: ["packages/ai/src/oauth.ts"],
				linesChanged: 20,
			},
			{
				sha: "103",
				subject: "fix: touch system2 internal file",
				files: ["packages/coding-agent/src/core/system2/sentinel.ts"],
				linesChanged: 15,
			},
		];

		const meaningful = filterMeaningfulUpstreamCommits(commits);
		expect(meaningful.map((c) => c.sha)).toEqual(["102", "103"]);

		const withoutDirect = filterMeaningfulUpstreamCommits(commits, { excludeDirectConflicts: true });
		expect(withoutDirect.map((c) => c.sha)).toEqual(["102"]);
	});
});

describe("auditSystem2HookFootprint & parseGitDiffNumstat", () => {
	it("partitions src/core/system2/** vs core pi files and passes when core hooks stay <= 25 lines", () => {
		const numstat = [
			"240\t0\tpackages/coding-agent/src/core/system2/upstream-sync.ts",
			"180\t12\tpackages/coding-agent/src/core/system2/reverie-ledger.ts",
			"8\t2\tpackages/coding-agent/src/config.ts",
			"14\t3\tpackages/coding-agent/src/modes/interactive/interactive-mode.ts",
		].join("\n");

		const diffs = parseGitDiffNumstat(numstat);
		const report = auditSystem2HookFootprint(diffs, { maxHookLinesPerFile: 25 });

		expect(report.withinBoundary).toBe(true);
		expect(report.system2FileCount).toBe(2);
		expect(report.system2LinesChanged).toBe(432);
		expect(report.coreFileCount).toBe(2);
		expect(report.coreLinesChanged).toBe(27);
		expect(report.flaggedCoreFiles).toEqual([]);
		expect(report.violations).toHaveLength(0);
		expect(report.encapsulationRatio).toBeGreaterThan(0.93);
	});

	it("flags any core pi file whose diff exceeds the configurable hook threshold", () => {
		const report = auditSystem2HookFootprint(
			[
				{ path: "packages/coding-agent/src/core/system2/factory.ts", insertions: 300, deletions: 10 },
				{ path: "packages/coding-agent/src/config.ts", insertions: 12, deletions: 2 },
				{ path: "packages/coding-agent/src/modes/interactive/interactive-mode.ts", insertions: 31, deletions: 8 },
			],
			{ maxHookLinesPerFile: 25 },
		);

		expect(report.withinBoundary).toBe(false);
		expect(report.flaggedCoreFiles).toEqual(["packages/coding-agent/src/modes/interactive/interactive-mode.ts"]);
		expect(report.violations).toHaveLength(1);
		expect(report.violations[0].linesChanged).toBe(39);
		expect(report.violations[0].threshold).toBe(25);
	});
});

describe("resolveSystem2ExecutionMode", () => {
	it("defaults to full System 2 mode with ModernBERT, Regime 2 thinking:off, LFM sentinel, and sub-25ms rollback", () => {
		const profile = resolveSystem2ExecutionMode({ argv: ["-p", "fix bug"], env: {} });
		expect(profile.mode).toBe("full");
		expect(profile.source).toBe("default");
		expect(profile.isVanilla).toBe(false);
		expect(profile.modernBertRouterEnabled).toBe(true);
		expect(profile.regime2ThinkingOffEnabled).toBe(true);
		expect(profile.lfmTelemetrySentinelEnabled).toBe(true);
		expect(profile.sub25msRollbackEnabled).toBe(true);
		expect(profile.strippedArgv).toEqual(["-p", "fix bug"]);
	});

	it("resolves --vanilla and --bypass-sys2 flags and strips them from downstream argv", () => {
		const vanilla = resolveSystem2ExecutionMode(["--vanilla", "--model", "claude-sonnet-4-6"], {
			SYSTEM2_MODE: "full",
		});
		expect(vanilla.mode).toBe("vanilla");
		expect(vanilla.source).toBe("cli_flag");
		expect(vanilla.isVanilla).toBe(true);
		expect(vanilla.modernBertRouterEnabled).toBe(false);
		expect(vanilla.regime2ThinkingOffEnabled).toBe(false);
		expect(vanilla.lfmTelemetrySentinelEnabled).toBe(false);
		expect(vanilla.sub25msRollbackEnabled).toBe(false);
		expect(vanilla.strippedArgv).toEqual(["--model", "claude-sonnet-4-6"]);

		const bypass = resolveSystem2ExecutionMode({ argv: ["--bypass-sys2", "chat"], env: {} });
		expect(bypass.mode).toBe("vanilla");
		expect(bypass.strippedArgv).toEqual(["chat"]);
	});

	it("resolves SYSTEM2_MODE=vanilla|full|sentinel-only from environment when no CLI flag is passed", () => {
		const envVanilla = resolveSystem2ExecutionMode({ argv: [], env: { SYSTEM2_MODE: "vanilla" } });
		expect(envVanilla.mode).toBe("vanilla");
		expect(envVanilla.source).toBe("env_var");

		const sentinelOnly = resolveSystem2ExecutionMode({ argv: [], env: { SYSTEM2_MODE: "sentinel-only" } });
		expect(sentinelOnly.mode).toBe("sentinel-only");
		expect(sentinelOnly.source).toBe("env_var");
		expect(sentinelOnly.lfmTelemetrySentinelEnabled).toBe(true);
		expect(sentinelOnly.modernBertRouterEnabled).toBe(false);
		expect(sentinelOnly.sub25msRollbackEnabled).toBe(false);
	});
});

describe("planUpstreamSyncWaves & renderUpstreamSyncSpecToml", () => {
	it("splits a 650-line multi-commit upstream batch into waves respecting sizeCap: 300", () => {
		const batch: UpstreamCommitInput[] = [
			{
				sha: "c1",
				subject: "fix(security): patch oauth token leak",
				files: ["packages/ai/src/oauth.ts"],
				linesChanged: 140,
			},
			{
				sha: "c2",
				subject: "feat(ai): update anthropic model catalog",
				files: ["packages/ai/src/models.ts"],
				linesChanged: 150,
			},
			{
				sha: "c3",
				subject: "fix(session): durable jsonl write retry",
				files: ["packages/coding-agent/src/core/session.ts"],
				linesChanged: 180,
			},
			{
				sha: "c4",
				subject: "fix(cli): config hook adjustment",
				files: ["packages/coding-agent/src/config.ts"],
				linesChanged: 110,
			},
			{
				sha: "c5",
				subject: "fix(tui): cursor restore on crash",
				files: ["packages/tui/src/index.ts"],
				linesChanged: 70,
			},
		];

		const waves = planUpstreamSyncWaves(batch, { sizeCap: 300 });
		expect(waves).toHaveLength(3);
		expect(waves.every((w) => w.totalLines <= 300)).toBe(true);

		expect(waves[0].commitShas).toEqual(["c1", "c2"]);
		expect(waves[0].totalLines).toBe(290);
		expect(waves[0].worktreePath).toBe("pi-system2-worktrees/upstream-sync-wave-1");

		expect(waves[1].commitShas).toEqual(["c3", "c4"]);
		expect(waves[1].totalLines).toBe(290);
		expect(waves[1].highestCollisionRisk).toBe("hook_boundary");

		expect(waves[2].commitShas).toEqual(["c5"]);
		expect(waves[2].totalLines).toBe(70);
	});

	it("isolates and flags a single atomic commit that exceeds sizeCap", () => {
		const batch: UpstreamCommitInput[] = [
			{ sha: "s1", subject: "fix: small patch", files: ["packages/ai/src/a.ts"], linesChanged: 80 },
			{
				sha: "big1",
				subject: "feat(provider): giant catalog refresh",
				files: ["packages/ai/src/b.ts"],
				linesChanged: 420,
			},
			{ sha: "s2", subject: "fix: follow-up patch", files: ["packages/ai/src/c.ts"], linesChanged: 90 },
		];

		const waves = planUpstreamSyncWaves(batch, { sizeCap: 300 });
		expect(waves).toHaveLength(3);
		expect(waves[0].totalLines).toBe(80);
		expect(waves[0].flaggedOversized).toBe(false);

		expect(waves[1].commitShas).toEqual(["big1"]);
		expect(waves[1].oversizedAtomicCommit).toBe(true);
		expect(waves[1].flaggedOversized).toBe(true);
		expect(waves[1].exceedsSizeCap).toBe(true);
		expect(waves[1].warnings[0]).toContain("exceeds size_cap");
		expect(waves.flaggedOversizedCommits).toEqual(["big1"]);

		expect(waves[2].totalLines).toBe(90);
		expect(waves[2].flaggedOversized).toBe(false);
	});

	it("renders a deterministic, valid spec.toml for a sync wave worktree", () => {
		const waves = planUpstreamSyncWaves(
			[
				{
					sha: "abc1234",
					subject: 'fix(security): harden "quoted" path check',
					files: ["packages/coding-agent/src/config.ts"],
					linesChanged: 45,
				},
			],
			{ sizeCap: 300 },
		);

		const toml = renderUpstreamSyncSpecToml(waves[0]);
		expect(toml).toContain('ticket = "S2-UPSYNC-01"');
		expect(toml).toContain('slug = "S2-UPSYNC-01-wave-1"');
		expect(toml).toContain("size_cap = 300");
		expect(toml).toContain("pi-system2-worktrees/upstream-sync-wave-1");
		expect(toml).toContain("abc1234");
		expect(toml).toContain("[[acceptance]]");
		expect(toml).toContain("line_count = 45");
	});
});

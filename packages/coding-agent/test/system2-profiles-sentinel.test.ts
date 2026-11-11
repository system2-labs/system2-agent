import { beforeEach, describe, expect, it } from "vitest";
import {
	getActiveProfile,
	getAvailableProfiles,
	getSentinelBuffer,
	ingestLogChunk,
	queryTelemetrySentinel,
	RollingLogBuffer,
	setActiveProfile,
} from "../src/core/system2/index.ts";

describe("system2 model profiles and sentinel tools", () => {
	beforeEach(() => {
		setActiveProfile("fast-coding");
		getSentinelBuffer().clear();
	});

	it("profile_switching_lifecycle: provides built-in profiles and supports safe hot-swapping", () => {
		const profiles = getAvailableProfiles();
		expect(profiles.length).toBe(5);

		const expectedIds = ["cybersec-redteam", "fast-coding", "multimodal-vision", "big-brain-hybrid", "lean-battery"];
		expect(profiles.map((p) => p.id)).toEqual(expect.arrayContaining(expectedIds));
		expect(getActiveProfile().id).toBe("fast-coding");

		// Hot-swap to cybersec-redteam
		const cybersec = setActiveProfile("cybersec-redteam");
		expect(cybersec.id).toBe("cybersec-redteam");
		expect(cybersec.recommendedVramGb).toBe(24);
		expect(cybersec.roles.system1).toBe("deepseek-v4-pro-qwen3.5-9b-uncensored-heretic");
		expect(cybersec.roles.system2).toBe("Huihui-Qwen3.8-27B-abliterated");
		expect(cybersec.roles.sentinel).toBe("lfm3-2b-omni-abliter8");
		expect(getActiveProfile().id).toBe("cybersec-redteam");

		// Hot-swap to big-brain-hybrid
		const bigBrain = setActiveProfile("big-brain-hybrid");
		expect(bigBrain.roles.remote).toBe("qwen3.8-flash-next");
		expect(bigBrain.recommendedVramGb).toBe(128);

		// Hot-swap using user alias
		const aliasProfile = setActiveProfile("coding-swe");
		expect(aliasProfile.id).toBe("fast-coding");

		const edgeAlias = setActiveProfile("edge-minimal");
		expect(edgeAlias.id).toBe("lean-battery");

		// Fallback test: invalid profile id defaults to fast-coding
		const fallback = setActiveProfile("unknown-profile-id");
		expect(fallback.id).toBe("fast-coding");
		expect(fallback.roles.gatekeeper).toBe("gemma-4-e2b-it-qat");
		expect(getActiveProfile().id).toBe("fast-coding");
	});

	it("sentinel_summary_stage1: ingests streaming logs and produces structured summary without full context dump", () => {
		const buffer = new RollingLogBuffer(100);
		buffer.ingestLogChunk("INFO: Server booted on port 8080\nDEBUG: Initializing subsystem");
		buffer.ingestLogChunk("ERROR: Connection refused to database\nINFO: Retrying connection...");
		buffer.ingestLogChunk("CRITICAL: panic: nil pointer dereference in handler\nWARN: Worker slowed down");
		buffer.ingestLogChunk("AssertionError [ERR_ASSERTION]: expected 200 but received 500\nTask failed");

		// Global summary without dump
		const summary = buffer.queryTelemetrySentinel();
		expect(summary.totalLines).toBe(8);
		expect(summary.errorCount).toBe(4);
		expect(summary.matchedErrors).toHaveLength(4);
		expect(summary.matchedErrors[0]).toEqual({ line: 3, text: "ERROR: Connection refused to database" });
		expect(summary.matchedErrors[1].text).toContain("panic");
		expect(summary.matchedErrors[2].text).toContain("AssertionError");
		expect(summary.matchedErrors[3].text).toContain("failed");

		// Query-filtered summary
		const panicSummary = buffer.queryTelemetrySentinel("panic");
		expect(panicSummary.errorCount).toBe(1);
		expect(panicSummary.matchedErrors[0].text).toContain("panic: nil pointer dereference");

		// Module-level functions
		ingestLogChunk("test log line\nERROR: module-level sentinel error");
		const modSummary = queryTelemetrySentinel();
		expect(modSummary.errorCount).toBe(1);
	});

	it("sentinel_excerpt_stage2_guard: excerpt_guard strictly clamps raw line retrieval to max 50 lines", () => {
		const buffer = new RollingLogBuffer(1000);
		const testLines = Array.from({ length: 200 }, (_, i) => `log line ${i + 1}`);
		buffer.ingestLogChunk(testLines.join("\n"));
		expect(buffer.getLineCount()).toBe(200);

		// Requesting 200 lines must be strictly clamped to 50
		const excerpt200 = buffer.queryLogExcerpt(0, 200);
		expect(excerpt200.lines).toHaveLength(50);
		expect(excerpt200.lines[0]).toBe("log line 1");
		expect(excerpt200.lines[49]).toBe("log line 50");
		expect(excerpt200.startLine).toBe(1);
		expect(excerpt200.endLine).toBe(50);
		expect(excerpt200.hasMore).toBe(true);

		// Default maxLines is 50
		const excerptDefault = buffer.queryLogExcerpt(50);
		expect(excerptDefault.lines).toHaveLength(50);
		expect(excerptDefault.startLine).toBe(51);
		expect(excerptDefault.endLine).toBe(100);
		expect(excerptDefault.hasMore).toBe(true);

		// End of buffer excerpt
		const excerptEnd = buffer.queryLogExcerpt(180, 50);
		expect(excerptEnd.lines).toHaveLength(20);
		expect(excerptEnd.startLine).toBe(181);
		expect(excerptEnd.endLine).toBe(200);
		expect(excerptEnd.hasMore).toBe(false);

		// Clamp min to at least 1 line
		const excerptMin = buffer.queryLogExcerpt(0, 0);
		expect(excerptMin.lines).toHaveLength(50);
	});
});

/**
 * System 2 Mondrian Developer Routing Insights and Footer Formatting.
 */

const NICKNAME_MAP: Array<[string, string]> = [
	["heretic", "Heretic"],
	["qwen3.5-9b", "Artisan"],
	["iq3_xxs", "Sweetspot"],
	["q2_k_xl", "Sub-Ten"],
	["smoll", "Smoll"],
	["gemma-4-e2b", "Gatekeeper"],
	["qwen3-vl", "Ocular"],
	["lfm3", "Nightwatch"],
	["lfm2", "Sentinel"],
	["splash-next", "Big-Brain"],
	["flash-next", "Big-Brain"],
	["splash", "Splash"],
];

/** Map physical model identifiers to clean cognitive nicknames. */
export function getModelNickname(modelId: string): string {
	const lower = modelId.toLowerCase().replace(/[-_]/g, "_");
	for (const [key, nick] of NICKNAME_MAP) {
		if (lower.includes(key.replace(/[-_]/g, "_"))) return nick;
	}
	return modelId;
}

/** Format routed model for TUI footer with Mondrian cognitive indicators. */
export function formatSystem2FooterModel(
	routed: { model: { id: string; provider: string }; thinkingLevel?: string },
	state?: any,
): string {
	const nickname = getModelNickname(routed.model.id);
	const s = state?.state ?? state;
	const rawTrack =
		typeof state === "string" ? state : (s?.track ?? s?.selected_track ?? s?.system2?.track ?? "general");
	const isSentinel =
		s?.isSentinel === true ||
		s?.system === "sentinel" ||
		rawTrack === "sentinel" ||
		nickname === "Sentinel" ||
		routed.model.id.toLowerCase().includes("sentinel");
	const isSys2 =
		!isSentinel &&
		(s?.system === 2 ||
			s?.system === "2" ||
			s?.system === "sys2" ||
			s?.system === "Sys2" ||
			s?.isDeliberative === true ||
			s?.mode === "deliberative" ||
			s?.model?.id === "deliberative" ||
			state?.model?.id === "deliberative" ||
			rawTrack.toLowerCase() === "sys2");

	const indicator = isSentinel
		? "\x1b[38;2;255;183;3m[Sentinel]\x1b[0m"
		: isSys2
			? `\x1b[38;2;61;139;170m[Sys2: ${rawTrack}]\x1b[0m`
			: `\x1b[38;2;239;66;35m[Sys1: ${rawTrack}]\x1b[0m`;

	const thinking = routed.thinkingLevel && routed.thinkingLevel !== "off" ? ` • ${routed.thinkingLevel}` : "";
	return `${indicator} ${nickname}${thinking}`;
}

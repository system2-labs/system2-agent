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
	routed?: { model: { id: string; provider: string }; thinkingLevel?: string } | null,
	state?: any,
): string {
	const s = state?.state ?? state;
	const rawTrack =
		typeof state === "string" ? state : (s?.track ?? s?.selected_track ?? s?.system2?.track ?? "general");
	const rawModelId = (state?.model?.id || s?.model?.id || "").toLowerCase();
	const isDeliberative =
		rawModelId.includes("deliberative") || s?.isDeliberative === true || s?.mode === "deliberative";
	const isSentinel =
		s?.isSentinel === true ||
		s?.system === "sentinel" ||
		rawTrack === "sentinel" ||
		(routed?.model?.id ? routed.model.id.toLowerCase().includes("sentinel") : false);
	const isSys1 = s?.system === 1 || s?.system === "1" || s?.system === "sys1" || s?.system === "Sys1";
	const isSys2 =
		!isSentinel &&
		!isSys1 &&
		(s?.system === 2 ||
			s?.system === "2" ||
			s?.system === "sys2" ||
			s?.system === "Sys2" ||
			isDeliberative ||
			rawTrack.toLowerCase() === "sys2" ||
			(!routed && !rawModelId));

	// Mondrian cognitive indicators:
	// Cadmium Yellow (#FFB703) for Sentinel
	// Cobalt Blue (#3D8BAA) for System 2 Deliberative
	// Cadmium Red (#EF4223) for System 1 Fast-track
	const indicator = isSentinel
		? "\x1b[38;2;255;183;3m[Sentinel]\x1b[0m"
		: isSys2
			? `\x1b[38;2;61;139;170m[Sys2: ${isDeliberative && !routed ? "Deliberative" : rawTrack}]\x1b[0m`
			: `\x1b[38;2;239;66;35m[Sys1: ${rawTrack === "general" && !routed ? "Auto" : rawTrack}]\x1b[0m`;

	if (!routed) {
		const level = state?.thinkingLevel || (isSys2 ? "medium" : "off");
		return `${indicator} • ${level}`;
	}

	const nickname = getModelNickname(routed.model.id);
	const thinking = routed.thinkingLevel && routed.thinkingLevel !== "off" ? ` • ${routed.thinkingLevel}` : "";
	return `${indicator} → \x1b[1m${nickname}\x1b[0m (${routed.model.id})${thinking}`;
}

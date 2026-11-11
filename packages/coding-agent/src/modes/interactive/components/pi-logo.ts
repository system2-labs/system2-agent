import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// System2 Official Brand Colors (from 17-system2-brand-design-system-and-palette.md)
const CORAL_RED = rgbColor(239, 66, 35); // #ef4223 System2 Identity & Coral Accent
const STEEL_BLUE = rgbColor(61, 139, 170); // #3d8baa System 1 Perception & Wanderer
const FOREST_EMERALD = rgbColor(62, 131, 99); // #3e8363 System 2 Verification & Invariants
const WHITE = rgbColor(255, 255, 255);
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/**
 * The System2 Mondrian S2 logo:
 * Uses Piet Mondrian style primary geometric color tiles (Steel Blue, Coral Red, Forest Emerald)
 * with high-contrast text and crisp half-block borders.
 *
 *   [ S ] [ 2 ]
 *   [───] [   ]
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const bg = (c: typeof CORAL_RED) => backgroundAnsi(c, mode);
	const fg = (c: typeof CORAL_RED) => foregroundAnsi(c, mode);

	// Line 1: Steel Blue tile with white bold "S", Coral Red tile with white bold "2"
	const top = `${bg(STEEL_BLUE)}${fg(WHITE)}${BOLD} S ${RESET}${bg(CORAL_RED)}${fg(WHITE)}${BOLD} 2 ${RESET} `;
	// Line 2: Forest Emerald base tile with divider, Coral Red base anchor
	const bottom = `${bg(FOREST_EMERALD)}${fg(WHITE)}───${RESET}${bg(CORAL_RED)}   ${RESET} `;

	return [top, bottom];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: "System2" with System in Steel Blue and 2 in Coral Red. */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(STEEL_BLUE, mode)}System${foregroundAnsi(CORAL_RED, mode)}2${RESET}`;
}

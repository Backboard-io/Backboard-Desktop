import { elevate } from "./blend.ts";
import { readableAnsiOrForeground } from "./contrast.ts";
import { palette } from "./palette.ts";

// Foreground/borders use ANSI names (respect the terminal theme); surfaces are
// elevation steps computed from the detected terminal background.

const FG = undefined; // terminal default foreground
const SECONDARY_TEXT_MIN_CONTRAST = 4.5;

function surfacesFor(bg: string): {
	surface1: string;
	surface2: string;
	surface3: string;
} {
	return {
		surface1: elevate(bg, 0.04),
		surface2: elevate(bg, 0.08),
		surface3: elevate(bg, 0.12),
	};
}

export function createTheme(bg: string = palette.bg) {
	const surfaces = surfacesFor(bg);
	const readableSecondaryText = readableAnsiOrForeground(
		"gray",
		[bg, surfaces.surface1],
		SECONDARY_TEXT_MIN_CONTRAST,
	);
	return {
		title: FG,
		text: FG,
		assistant: FG,
		inputText: FG,
		user: "cyan",
		model: "cyan",
		accent: "cyan",
		accentBright: "cyan",
		borderFocused: "cyan",
		toolRunning: "cyan",
		spinner: "cyan",
		secondaryText: readableSecondaryText,
		readableSecondaryText,
		subtle: readableSecondaryText,
		subtleDecoration: "gray",
		spinnerMeta: "gray",
		border: "gray",
		inputPlaceholder: "gray",
		inputBackground: "black",
		success: "green",
		active: "green",
		toolDone: "green",
		error: "red",
		toolError: "red",
		warning: "yellow",
		spinnerHighlightTrail: "blue",
		spinnerHighlightCore: "cyan",
		spinnerHighlightLead: "cyanBright",

		surface1: surfaces.surface1,
		surface2: surfaces.surface2,
		surface3: surfaces.surface3,
		inputSurfaceBackground: surfaces.surface1,
		inputHighlight: surfaces.surface3,
		highlightBackground: surfaces.surface3,
	} as const;
}

export const defaultTheme = createTheme();

export type Theme = typeof defaultTheme;

export let theme: Theme = defaultTheme;

export function setTheme(value: Theme): void {
	theme = value;
}

/** Human browser names and the installed macOS application bundle names. */
export function canonicalAppName(name: string): string {
	const trimmed = name.trim();
	const aliases: Record<string, string> = {
		brave: "Brave Browser",
		"brave browser": "Brave Browser",
		chrome: "Google Chrome",
		"google chrome": "Google Chrome",
		edge: "Microsoft Edge",
		"microsoft edge": "Microsoft Edge",
		safari: "Safari",
		firefox: "Firefox",
	};
	return aliases[trimmed.toLowerCase()] ?? trimmed;
}

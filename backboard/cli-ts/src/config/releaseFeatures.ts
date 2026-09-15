/** Windows releases support Backboard and provider API keys, not BYOS. */
export function supportsSubscriptions(platform: string = process.platform): boolean {
	return platform !== "win32";
}

/** Subscription connections are disabled on every platform in this release. */
export function supportsSubscriptions(_platform: string = process.platform): boolean {
	return false;
}

export function isProviderAvailable(provider: string): boolean {
	return !["openai-subscription", "anthropic-subscription"].includes(provider.trim().toLowerCase());
}

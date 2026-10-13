import { readBackboardConfig } from "../../config/backboardConfig.ts";
import { DEFAULT_API_URL, normalizeApiUrl } from "../../config/env.ts";

/**
 * The page every browser sign-in ends on: Backboard SSO's own completion page,
 * on the configured backend. The ChatGPT callback redirects here and Claude's
 * login opens it, so all three sign-ins finish in the same place.
 */
export function backboardOAuthCompleteUrl(homeDir?: string): string {
	let apiUrl = DEFAULT_API_URL;
	try {
		apiUrl =
			process.env.BACKBOARD_API_URL?.trim() ||
			readBackboardConfig(homeDir).apiUrl ||
			DEFAULT_API_URL;
	} catch {
		// An unreadable config still has a sensible landing page.
	}
	return new URL("/oauth/device/complete", normalizeApiUrl(apiUrl)).toString();
}

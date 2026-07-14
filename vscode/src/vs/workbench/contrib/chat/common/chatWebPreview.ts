/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mirrors RightWorkbenchCommandId.OpenBrowser (vs/sessions/contrib/rightWorkbench);
 * referenced by id because workbench code must not import from vs/sessions. The
 * command only exists in the sessions window — callers must handle failure.
 */
export const OPEN_RIGHT_WORKBENCH_BROWSER_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.openBrowser';

const LOCALHOST_URL_RE = /(?<scheme>https?:\/\/)?(?<host>localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?<port>:\d{2,5})?(?<path>\/[^\s"'<>)\]]*)?/gi;

/** Cap on how much tool output is scanned for URLs (terminal logs can be huge). */
const MAX_SCAN_LENGTH = 100_000;

/**
 * Finds local dev-server URLs in a piece of text (tool input, tool output,
 * artifact uri, ...) and normalizes them to openable `http://` URLs — one per
 * distinct origin, in order of appearance. Wildcard hosts (`0.0.0.0`) are
 * rewritten to `localhost` so the resulting URL is navigable.
 */
export function extractLocalhostUrls(text: string, maxResults = 4): string[] {
	const results: string[] = [];
	const seenOrigins = new Set<string>();
	for (const match of text.slice(0, MAX_SCAN_LENGTH).matchAll(LOCALHOST_URL_RE)) {
		if (!match.groups) {
			continue;
		}
		if (!match.groups.scheme && !match.groups.port) {
			continue; // bare host word in prose (e.g. "binds to localhost") is not a URL
		}
		const scheme = match.groups.scheme ?? 'http://';
		const host = match.groups.host === '0.0.0.0' ? 'localhost' : match.groups.host;
		const url = `${scheme}${host}${match.groups.port ?? ''}${match.groups.path ?? ''}`;
		const origin = getWebPreviewOriginKey(url);
		if (!origin || seenOrigins.has(origin)) {
			continue;
		}
		seenOrigins.add(origin);
		results.push(url);
		if (results.length >= maxResults) {
			break;
		}
	}
	return results;
}

/**
 * Finds the first local dev-server URL in a piece of text. See
 * {@link extractLocalhostUrls}.
 */
export function extractLocalhostUrl(text: string): string | undefined {
	return extractLocalhostUrls(text, 1).at(0);
}

/**
 * Dedupe key for web previews: the URL origin, with loopback hosts collapsed
 * onto `localhost` so `http://127.0.0.1:3000` and `http://localhost:3000`
 * count as the same app. Returns `undefined` for unparseable URLs.
 */
export function getWebPreviewOriginKey(url: string): string | undefined {
	const parsed = URL.parse(url);
	if (!parsed) {
		return undefined;
	}
	const host = parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0' || parsed.hostname === '[::1]' || parsed.hostname === '::1'
		? 'localhost'
		: parsed.hostname;
	return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ''}`.toLowerCase();
}

/**
 * Whether the URL points at a local dev server (localhost or loopback host).
 */
export function isLocalWebPreviewUrl(url: string): boolean {
	const parsed = URL.parse(url);
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		return false;
	}
	return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i.test(parsed.hostname);
}

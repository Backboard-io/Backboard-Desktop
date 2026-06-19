/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { env } from 'vscode';
import { Config } from '../config';
import { Log } from '../common/logger';

let server: http.Server | undefined;
let startPromise: Promise<string> | undefined;

const GITHUB_AUTHENTICATION_CALLBACK_AUTHORITIES = new Set([
	'backboard.github-authentication',
	'vscode.github-authentication'
]);

function isLoopbackRedirectTarget(url: URL): boolean {
	return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.pathname === '/callback';
}

function isBackboardRedirectTarget(url: URL): boolean {
	return url.protocol === `${env.uriScheme}:` && GITHUB_AUTHENTICATION_CALLBACK_AUTHORITIES.has(url.hostname);
}

function decodeTarget(value: string): URL | undefined {
	const candidates = [value];
	try {
		const decoded = decodeURIComponent(value);
		if (decoded !== value) {
			candidates.push(decoded);
		}
	} catch {
		// Keep the original value as the only candidate.
	}

	for (const candidate of candidates) {
		try {
			return new URL(candidate);
		} catch {
			// Try the next candidate.
		}
	}

	return undefined;
}

function appendOAuthResult(target: URL, code: string | null, state: string | null, error: string | null, errorDescription: string | null): URL {
	if (code) {
		target.searchParams.set('code', code);
	}
	if (state && isLoopbackRedirectTarget(target)) {
		target.searchParams.set('state', state);
	}
	if (error) {
		target.searchParams.set('error', error);
	}
	if (errorDescription) {
		target.searchParams.set('error_description', errorDescription);
	}
	return target;
}

function htmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function sendLaunchPage(res: http.ServerResponse, target: URL): void {
	const targetHref = target.toString();
	const targetJson = JSON.stringify(targetHref);
	const targetHtml = htmlEscape(targetHref);

	res.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store'
	});
	res.end(`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Return to Backboard Studio</title>
	<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
	<p>Returning to Backboard Studio...</p>
	<p><a href="${targetHtml}">Open Backboard Studio</a></p>
	<script>window.location.replace(${targetJson});</script>
</body>
</html>`);
}

function sendUnsupported(res: http.ServerResponse, target: string | undefined): void {
	res.writeHead(400, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store'
	});
	res.end(`Unsupported redirect target${target ? `: ${target}` : ''}`);
}

function handleRedirect(req: http.IncomingMessage, res: http.ServerResponse): void {
	const requestUrl = new URL(req.url ?? '/', Config.gitHubRedirectUri);
	if (requestUrl.pathname !== '/redirect') {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Not found');
		return;
	}

	const code = requestUrl.searchParams.get('code');
	const state = requestUrl.searchParams.get('state');
	const error = requestUrl.searchParams.get('error');
	const errorDescription = requestUrl.searchParams.get('error_description');
	const directTarget = requestUrl.searchParams.get('url') ?? requestUrl.searchParams.get('uri');
	const target = directTarget ? decodeTarget(directTarget) : state ? decodeTarget(state) : undefined;

	if (!target || (!isLoopbackRedirectTarget(target) && !isBackboardRedirectTarget(target))) {
		sendUnsupported(res, target?.toString() ?? directTarget ?? state ?? undefined);
		return;
	}

	const redirectTarget = appendOAuthResult(target, code, state, error, errorDescription);
	if (isLoopbackRedirectTarget(redirectTarget)) {
		res.writeHead(302, {
			location: redirectTarget.toString(),
			'Cache-Control': 'no-store'
		});
		res.end();
		return;
	}

	sendLaunchPage(res, redirectTarget);
}

export async function ensureBackboardRedirectServer(logger: Log): Promise<string> {
	if (startPromise) {
		return startPromise;
	}

	startPromise = new Promise<string>((resolve, reject) => {
		server = http.createServer(handleRedirect);
		server.once('error', error => {
			if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
				logger.warn(`Backboard GitHub OAuth redirect bridge port ${Config.gitHubRedirectPort} is already in use. Reusing configured redirect URI ${Config.gitHubRedirectUri}.`);
				resolve(Config.gitHubRedirectUri);
				return;
			}

			startPromise = undefined;
			reject(error);
		});
		server.once('listening', () => {
			logger.info(`Backboard GitHub OAuth redirect bridge listening on ${Config.gitHubRedirectUri}`);
			resolve(Config.gitHubRedirectUri);
		});
		server.listen(Config.gitHubRedirectPort, '127.0.0.1');
	});

	return startPromise;
}

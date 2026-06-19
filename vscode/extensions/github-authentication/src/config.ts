/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IConfig {
	// The client ID of the GitHub OAuth app
	gitHubClientId: string;
	gitHubClientSecret?: string;
	gitHubRedirectPort: number;
	gitHubRedirectUri: string;
}

function readEnv(name: string): string | undefined {
	const value = typeof process !== 'undefined' ? process.env[name]?.trim() : undefined;
	return value || undefined;
}

function readPortEnv(name: string, fallback: number): number {
	const value = readEnv(name);
	if (!value) {
		return fallback;
	}

	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

const defaultGitHubRedirectPort = readPortEnv('BACKBOARD_GITHUB_OAUTH_REDIRECT_PORT', 3001);

// For easy access to mixin client ID and secret
//
// NOTE: GitHub client secrets cannot be secured when running in a native client so in other words, the client secret is
// not really a secret... so we allow the client secret in code. It is brought in before we publish VS Code. Reference:
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app#client-secrets
export const Config: IConfig = {
	gitHubClientId: readEnv('BACKBOARD_GITHUB_OAUTH_CLIENT_ID') ?? 'Ov23liqywLfp4vQtPQAu',
	gitHubClientSecret: readEnv('BACKBOARD_GITHUB_OAUTH_CLIENT_SECRET'),
	gitHubRedirectPort: defaultGitHubRedirectPort,
	gitHubRedirectUri: readEnv('BACKBOARD_GITHUB_OAUTH_REDIRECT_URI') ?? `http://127.0.0.1:${defaultGitHubRedirectPort}/redirect`
};

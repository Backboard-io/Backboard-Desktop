/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { credentialFingerprint, postJson, signInSource, studioPlatform, usageTelemetryAllowed } from './studioTrackingCore';
import { readCurrentAppVersion, readPackagedBackboardChannel } from './updates';

const FINGERPRINT_KEY = 'backboard.studio.signInFingerprint';
/** Development builds report only when this is set, mirroring the main process's first-launch reporter. */
const TRACKING_OPT_IN_ENV = 'BACKBOARD_STUDIO_TRACKING_API_URL';
const REQUEST_TIMEOUT_MS = 15_000;

export interface StudioApiConfig {
	readonly baseUrl: string;
	readonly headers: Readonly<Record<string, string>>;
}

export interface StudioSignInTrackingOptions {
	/** The Backboard API the IDE is signed in to and its credential headers, or undefined when signed out. */
	readonly apiConfig: () => StudioApiConfig | undefined;
	readonly output: vscode.OutputChannel;
}

/**
 * Reports each Backboard credential the IDE holds, so the server can count every account's
 * first IDE sign-in. The server resolves the account from the credential and keeps one row per
 * account; the stored fingerprint only avoids repeating a report for the same credential.
 * The returned check can run on any trigger: the credential, not the trigger, decides whether
 * it is reported as a new sign-in or as a session the IDE started with.
 *
 * Optional telemetry: a failed report is logged and retried on the next check.
 */
export function registerStudioSignInTracking(context: vscode.ExtensionContext, options: StudioSignInTrackingOptions): () => void {
	const startup = options.apiConfig();
	const startupFingerprint = startup && credentialFingerprint(startup.baseUrl, startup.headers);
	let inFlight = false;
	return () => {
		if (inFlight || !trackingAllowed()) {
			return;
		}
		const api = options.apiConfig();
		const platform = studioPlatform(process.platform, process.arch);
		if (!api || !platform) {
			return;
		}
		const fingerprint = credentialFingerprint(api.baseUrl, api.headers);
		if (context.globalState.get<string>(FINGERPRINT_KEY) === fingerprint) {
			return;
		}

		inFlight = true;
		const version = readCurrentAppVersion();
		const body = { platform, version, channel: readPackagedBackboardChannel() ?? 'dev', source: signInSource(fingerprint, startupFingerprint) };
		postJson(`${api.baseUrl}/studio/events/first-sign-in`, { ...api.headers, 'X-Backboard-Client': `studio/${version}` }, body, REQUEST_TIMEOUT_MS)
			.then(async status => {
				if (status >= 200 && status < 300) {
					await context.globalState.update(FINGERPRINT_KEY, fingerprint);
				} else {
					options.output.appendLine(`[studioTracking] Sign-in report was not accepted (HTTP ${status}).`);
				}
			}, error => {
				options.output.appendLine(`[studioTracking] Sign-in report failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				inFlight = false;
			});
	};
}

function trackingAllowed(): boolean {
	// A remote window's extension host sees the remote machine's platform and credentials.
	if (vscode.env.remoteName) {
		return false;
	}
	if (!readPackagedBackboardChannel() && !process.env[TRACKING_OPT_IN_ENV]) {
		return false;
	}
	const telemetry = vscode.workspace.getConfiguration('telemetry');
	return usageTelemetryAllowed(telemetry.get<string>('telemetryLevel'), telemetry.get<boolean>('enableTelemetry'), telemetry.get<boolean>('enableCrashReporter'));
}

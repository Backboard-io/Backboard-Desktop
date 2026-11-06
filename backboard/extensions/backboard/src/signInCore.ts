/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BackboardDeviceCodeResponse, BackboardOAuthTokens } from './types';

/** How a sign-in ended. Failures carry the reason instead of showing it, so the caller decides where it goes. */
export type BackboardSignInOutcome =
	| { readonly status: 'signedIn' }
	| { readonly status: 'cancelled' }
	| { readonly status: 'failed'; readonly error: string };

/** The link to finish a sign-in in any browser, for when the one that opened is not the right one. */
export interface BackboardSignInLink {
	readonly url: string;
	readonly userCode: string;
}

export interface BackboardSignInSteps {
	requestDeviceCode(): Promise<BackboardDeviceCodeResponse>;
	openBrowser(url: string): Promise<void>;
	/** Waits for approval in the browser; stops once `isCancelled` returns true. */
	pollForTokens(device: BackboardDeviceCodeResponse, isCancelled: () => boolean): Promise<BackboardOAuthTokens>;
	save(tokens: BackboardOAuthTokens): Promise<void>;
}

interface PendingSignIn {
	cancelled: boolean;
	device?: BackboardDeviceCodeResponse;
	cancel(): void;
}

const CANCELLED: BackboardSignInOutcome = { status: 'cancelled' };

/**
 * The device-code sign-in in progress in this window, so whoever started it
 * can cancel it or hand out its link instead of waiting out the timeout.
 */
export class BackboardSignIns {
	private pending: PendingSignIn | undefined;

	/** Runs a sign-in. Starting one cancels any still waiting: the user has moved on from it. */
	async run(steps: BackboardSignInSteps): Promise<BackboardSignInOutcome> {
		this.cancel();
		let resolveCancelled!: (outcome: BackboardSignInOutcome) => void;
		const cancelled = new Promise<BackboardSignInOutcome>(resolve => resolveCancelled = resolve);
		const signIn: PendingSignIn = {
			cancelled: false,
			cancel: () => {
				signIn.cancelled = true;
				resolveCancelled(CANCELLED);
			},
		};
		this.pending = signIn;

		const attempt = (async (): Promise<BackboardSignInOutcome> => {
			const device = await steps.requestDeviceCode();
			if (signIn.cancelled) {
				return CANCELLED;
			}
			signIn.device = device;
			await steps.openBrowser(device.verification_uri_complete);
			const tokens = await steps.pollForTokens(device, () => signIn.cancelled);
			if (signIn.cancelled) {
				return CANCELLED;
			}
			await steps.save(tokens);
			return { status: 'signedIn' };
		})().catch((error: unknown): BackboardSignInOutcome => signIn.cancelled ? CANCELLED : { status: 'failed', error: error instanceof Error ? error.message : String(error) });

		try {
			// A cancel answers at once, even while a request is still out.
			return await Promise.race([attempt, cancelled]);
		} finally {
			if (this.pending === signIn) {
				this.pending = undefined;
			}
		}
	}

	/** Returns false when no sign-in was waiting. */
	cancel(): boolean {
		const signIn = this.pending;
		this.pending = undefined;
		signIn?.cancel();
		return !!signIn;
	}

	/** Undefined until the device code has arrived. */
	link(): BackboardSignInLink | undefined {
		const device = this.pending?.device;
		return device && { url: device.verification_uri_complete, userCode: device.user_code };
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const enum ChatErrorReportingConfig {
	Enabled = 'chat.errorReporting.enabled',
	Url = 'chat.errorReporting.url'
}

/**
 * Details of a single chat error, gathered at the place where the error is
 * rendered. The service enriches this with product, OS and user context
 * before uploading.
 */
export interface IChatErrorReportDetails {
	/**
	 * Stable key identifying this error occurrence (e.g. the request id), used
	 * to remember that it has already been reported so re-renders of the same
	 * error don't offer to send it again.
	 */
	readonly reportKey: string;
	readonly message: string;
	readonly code?: string;
	/** The renderer content kind the error surfaced as (e.g. 'errorDetails'). */
	readonly kind?: string;
	readonly responseIsIncomplete?: boolean;
	readonly responseIsFiltered?: boolean;
	readonly sessionResource?: string;
	readonly requestId?: string;
	readonly agentId?: string;
	readonly modelId?: string;
}

export const IChatErrorReportService = createDecorator<IChatErrorReportService>('chatErrorReportService');

/**
 * Uploads error reports for errors that surfaced in a chat conversation to a
 * remote log store (an S3 bucket by default), so users can share failures
 * without having to copy them out of the chat manually.
 */
export interface IChatErrorReportService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires with the report key when an error report was uploaded successfully,
	 * so all UI offering to send that error can reflect the sent state.
	 */
	readonly onDidReport: Event<string>;

	/**
	 * Whether error reporting is available and enabled (a transport exists for
	 * this target, the setting is on and an upload endpoint is configured).
	 */
	isEnabled(): boolean;

	/**
	 * Whether the error identified by the given key was already reported in
	 * this window.
	 */
	hasReported(reportKey: string): boolean;

	/**
	 * Builds the error report and uploads it to the configured endpoint.
	 * Rejects when the upload fails; the same details can be passed again to retry.
	 */
	report(details: IChatErrorReportDetails): Promise<void>;

	/**
	 * Shows a notification offering to submit the error report. Each error is
	 * only offered once per window, and the notification honors the user's
	 * "Don't Show Again" choice.
	 */
	promptToReport(details: IChatErrorReportDetails): void;
}

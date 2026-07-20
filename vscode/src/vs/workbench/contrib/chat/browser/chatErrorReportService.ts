/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IChatErrorReportDetails, IChatErrorReportService } from '../common/chatErrorReporting.js';

/**
 * Browser (web) fallback: the upload must run in the Electron main process to
 * avoid CORS restrictions, so error reporting is not available in web targets.
 * Desktop targets override this registration with `NativeChatErrorReportService`.
 */
export class BrowserChatErrorReportService implements IChatErrorReportService {

	declare readonly _serviceBrand: undefined;

	readonly onDidReport = Event.None;

	isEnabled(): boolean {
		return false;
	}

	hasReported(_reportKey: string): boolean {
		return false;
	}

	report(_details: IChatErrorReportDetails): Promise<void> {
		throw new Error('Error reporting is not available in the web.');
	}

	promptToReport(_details: IChatErrorReportDetails): void {
		// not available in the web
	}
}

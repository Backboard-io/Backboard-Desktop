/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IBackboardBillingService, OPEN_BILLING_COMMAND_ID, billingReturn } from '../common/backboardBilling.js';

class BackboardBillingUrlContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.backboardBillingUrl';
	constructor(
		@IURLService urlService: IURLService,
		@ICommandService commandService: ICommandService,
		@IBackboardBillingService billing: IBackboardBillingService,
		@ILogService logService: ILogService,
	) {
		super();
		this._register(urlService.registerHandler({
			handleURL: async (uri: URI) => {
				if (uri.scheme !== 'backboard') { return false; }
				const result = billingReturn(uri);
				if (!result) { return false; }
				await commandService.executeCommand(OPEN_BILLING_COMMAND_ID);
				void billing.refresh(result.sessionId).catch(() => logService.warn('[Backboard Billing] Could not refresh after checkout.'));
				return true;
			}
		}));
	}
}
registerWorkbenchContribution2(BackboardBillingUrlContribution.ID, BackboardBillingUrlContribution, WorkbenchPhase.BlockRestore);

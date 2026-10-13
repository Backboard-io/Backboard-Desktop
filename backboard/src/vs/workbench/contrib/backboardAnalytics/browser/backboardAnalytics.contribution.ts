/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IBackboardAnalyticsService } from '../../../services/backboardAnalytics/common/backboardAnalytics.js';
import '../../../services/backboardAnalytics/browser/backboardAnalyticsService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { BackboardAuthContextKeys } from '../../chat/common/backboardAuth.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IBackboardUserInfo, resolveBackboardUserInfo } from '../../chat/browser/backboardUserInfo.js';
import { BackboardConversions } from './backboardConversions.js';

const FIRST_OPENED_KEY = 'backboardAnalytics.firstOpened';
const FIRST_MESSAGE_KEY = 'backboardAnalytics.firstChatMessage';
const SIGN_IN_COMMANDS = new Set(['backboard.signIn', 'backboard.extension.signIn']);
const SIGNED_IN_CONTEXT = new Set([BackboardAuthContextKeys.signedIn.key]);

/** Commands that send the user to app.backboard.io to pay. */
const CHECKOUT_COMMANDS = new Set(['workbench.action.chat.upgradePlan', 'workbench.action.chat.manageAdditionalSpend']);
/**
 * Desktop product analytics and ad conversions: opens, sign-in identity, the
 * first chat (activation), Upgrade clicks (checkout). Confirmed revenue comes from the billing backend.
 * Onboarding events are sent by the onboarding flow itself.
 */
class BackboardAnalyticsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.backboardAnalytics';

	private readonly conversions: BackboardConversions;
	private accountId: string | undefined;
	private authRevision = 0;
	private loginIntent = false;

	constructor(
		@IBackboardAnalyticsService private readonly analytics: IBackboardAnalyticsService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatService chatService: IChatService,
		@ICommandService commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.conversions = instantiationService.createInstance(BackboardConversions);
		if (!analytics.enabled && !this.conversions.enabled) {
			return;
		}

		if (contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) !== true) {
			analytics.reset();
		}

		if (!this.storageService.getBoolean(FIRST_OPENED_KEY, StorageScope.APPLICATION)) {
			this.storageService.store(FIRST_OPENED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			analytics.capture('app_first_opened');
		}
		analytics.capture('app_opened');

		void this.onSignedInChanged();
		this._register(contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(SIGNED_IN_CONTEXT)) {
				void this.onSignedInChanged();
			}
		}));

		this._register(chatService.onDidSubmitRequest(() => {
			analytics.capture('chat_message_sent');
			const firstMessageKey = `${FIRST_MESSAGE_KEY}.${this.accountId ?? 'anonymous'}`;
			if (!this.storageService.getBoolean(firstMessageKey, StorageScope.APPLICATION)) {
				this.storageService.store(firstMessageKey, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
				void this.conversions.report('first_chat_message_sent');
			}
		}));

		this._register(commandService.onWillExecuteCommand(e => {
			if (SIGN_IN_COMMANDS.has(e.commandId)) {
				this.loginIntent = contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) !== true;
			}
			if (CHECKOUT_COMMANDS.has(e.commandId)) {
				this.onCheckoutStarted(e.commandId);
			}
		}));

	}

	private onCheckoutStarted(commandId: string): void {
		void this.conversions.report('checkout_started', { kind: commandId === 'workbench.action.chat.upgradePlan' ? 'upgrade' : 'additional_spend' });
	}

	private async onSignedInChanged(): Promise<void> {
		const revision = ++this.authRevision;
		if (this.contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) !== true) {
			if (this.accountId) { this.analytics.capture('signed_out'); }
			this.accountId = undefined;
			this.analytics.reset();
			return;
		}
		let info: IBackboardUserInfo;
		try {
			info = await resolveBackboardUserInfo(this.fileService, this.pathService, this.requestService, this.logService, true);
		} catch (error) {
			this.logService.trace('[backboardAnalytics] user info lookup failed', error);
			return;
		}
		if (revision !== this.authRevision || this.contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) !== true) {
			return;
		}
		// OIDC sub is the same immutable user ID used by app.backboard.io.
		const userId = info.id;
		if (!userId) { return; }
		const newSession = this.accountId !== userId;
		this.accountId = userId;
		this.analytics.identify(userId, { email: info.email, name: info.name, plan: info.plan });
		if (newSession) { this.analytics.capture('account_session_started', { plan: info.plan }); }
		if (this.loginIntent) {
			this.loginIntent = false;
			void this.conversions.report('signed_in', { kind: info.plan });
		}

	}
}

registerWorkbenchContribution2(BackboardAnalyticsContribution.ID, BackboardAnalyticsContribution, WorkbenchPhase.Eventually);

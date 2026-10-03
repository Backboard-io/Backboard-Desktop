/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
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
import { IHostService } from '../../../services/host/browser/host.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { BackboardAuthContextKeys } from '../../chat/common/backboardAuth.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IBackboardUserInfo, resolveBackboardUserInfo } from '../../chat/browser/backboardUserInfo.js';
import { BackboardConversions } from './backboardConversions.js';

const FIRST_OPENED_KEY = 'backboardAnalytics.firstOpened';
const FIRST_MESSAGE_KEY = 'backboardAnalytics.firstChatMessage';
const SIGNED_IN_AS_KEY = 'backboardAnalytics.signedInAs';
const SIGNED_IN_CONTEXT = new Set([BackboardAuthContextKeys.signedIn.key]);

/** Commands that send the user to app.backboard.io to pay. */
const CHECKOUT_COMMANDS = new Set(['workbench.action.chat.upgradePlan', 'workbench.action.chat.manageAdditionalSpend']);
/** After an Upgrade click, look for the payment this often, for this long. */
const CHECKOUT_POLL_MS = 60_000;
const CHECKOUT_POLL_FOR_MS = 20 * 60_000;
/** Background purchase check (renewals, auto-reload, payments made elsewhere). */
const PURCHASE_POLL_MS = 30 * 60_000;
/** Don't hit the billing API more often than this, however often focus flips. */
const PURCHASE_CHECK_MIN_GAP_MS = 60_000;

/**
 * Desktop product analytics and ad conversions: opens, sign-in identity, the
 * first chat (activation), Upgrade clicks (checkout) and purchases.
 * Onboarding events are sent by the onboarding flow itself.
 */
class BackboardAnalyticsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.backboardAnalytics';

	private readonly conversions: BackboardConversions;
	private readonly checkoutPoll = this._register(new MutableDisposable<IntervalTimer>());
	private accountId: string | undefined;
	private lastPurchaseCheck = 0;

	constructor(
		@IBackboardAnalyticsService private readonly analytics: IBackboardAnalyticsService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatService chatService: IChatService,
		@ICommandService commandService: ICommandService,
		@IHostService hostService: IHostService,
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
			if (!this.storageService.getBoolean(FIRST_MESSAGE_KEY, StorageScope.APPLICATION)) {
				this.storageService.store(FIRST_MESSAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
				void this.conversions.report('first_chat_message_sent');
			}
		}));

		this._register(commandService.onWillExecuteCommand(e => {
			if (CHECKOUT_COMMANDS.has(e.commandId)) {
				this.onCheckoutStarted(e.commandId);
			}
		}));

		// People pay in the browser and come back: that's the moment to look.
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				void this.checkPurchases();
			}
		}));
		const backgroundPoll = this._register(new IntervalTimer());
		backgroundPoll.cancelAndSet(() => void this.checkPurchases(), PURCHASE_POLL_MS);
	}

	private onCheckoutStarted(commandId: string): void {
		void this.conversions.report('checkout_started', { kind: commandId === 'workbench.action.chat.upgradePlan' ? 'upgrade' : 'additional_spend' });
		const poll = new IntervalTimer();
		const startedAt = Date.now();
		poll.cancelAndSet(() => {
			if (Date.now() - startedAt > CHECKOUT_POLL_FOR_MS) {
				this.checkoutPoll.clear();
				return;
			}
			void this.checkPurchases(true);
		}, CHECKOUT_POLL_MS);
		this.checkoutPoll.value = poll;
	}

	private async checkPurchases(force = false): Promise<void> {
		if (!this.accountId || (!force && Date.now() - this.lastPurchaseCheck < PURCHASE_CHECK_MIN_GAP_MS)) {
			return;
		}
		this.lastPurchaseCheck = Date.now();
		await this.conversions.checkPurchases(this.accountId);
	}

	private async onSignedInChanged(): Promise<void> {
		if (this.contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) !== true) {
			this.accountId = undefined;
			return;
		}
		// The context key starts false and flips once credentials are read, so
		// a false -> true flip happens on every launch. A sign-in is counted
		// only when this install sees an account it hasn't seen before.
		let info: IBackboardUserInfo;
		try {
			info = await resolveBackboardUserInfo(this.fileService, this.pathService, this.requestService, this.logService);
		} catch (error) {
			this.logService.trace('[backboardAnalytics] user info lookup failed', error);
			return;
		}
		const userId = info.email?.toLowerCase();
		if (!userId) {
			return;
		}
		this.accountId = userId;
		this.analytics.identify(userId, { email: info.email, name: info.name, plan: info.plan });
		if (this.storageService.get(SIGNED_IN_AS_KEY, StorageScope.APPLICATION) !== userId) {
			this.storageService.store(SIGNED_IN_AS_KEY, userId, StorageScope.APPLICATION, StorageTarget.MACHINE);
			void this.conversions.report('signed_in', { kind: info.plan });
		}
		// Sets the ledger baseline on first sign-in, so only later payments count.
		await this.checkPurchases(true);
	}
}

registerWorkbenchContribution2(BackboardAnalyticsContribution.ID, BackboardAnalyticsContribution, WorkbenchPhase.Eventually);

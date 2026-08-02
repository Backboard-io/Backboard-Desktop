/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ChatViewContainerId } from './chat.js';
import { isAgentPanelContainer } from './agentPanelContainers.js';

/**
 * Makes the Chat panel behave like a permanent, built-in part of the workbench.
 *
 * The rule: **the right (auxiliary) bar belongs to Chat, unless the user has
 * deliberately placed some other view there.** From that single rule:
 *   - Chat is always on the right by default.
 *   - Agent panels installed from the marketplace (Claude Code, Codex) share the
 *     right with Chat as sibling tabs, so they do not count as "some other view".
 *   - If the user moves the file explorer / another view to the right, the right
 *     is no longer "reserved" and Chat is left wherever it is (e.g. the left).
 *   - The right bar is never left visible-but-empty (the "Drag a view here"
 *     broken state).
 *
 * Two mechanisms:
 *   1. A one-time repair (per profile) that reclaims the right for Chat if a
 *      stale saved layout orphaned it — this heals profiles damaged by an
 *      earlier build without fighting deliberate future rearrangement.
 *   2. An ongoing guard that re-fills the right with Chat whenever the auxiliary
 *      bar is shown but empty. It never force-opens a bar the user has closed
 *      and never touches the bar when the user has another view active there.
 *
 * Editor window only — it no-ops in the agent-sessions window, which owns its
 * own layout policy (gated on {@link IViewDescriptorService.canMoveViews}).
 */
export class ChatPanelResilienceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatPanelResilience';
	private static readonly REPAIR_STORAGE_KEY = 'chat.panelResilience.repair.v1';

	/**
	 * Runtime id of a legacy Backboard extension container that a since-removed
	 * layout experiment could have stuck on the right. It is not a deliberate
	 * user arrangement, so it never counts as "reserving" the right and is
	 * evicted back to its default during the one-time repair.
	 */
	private static readonly LEGACY_BACKBOARD_CONTAINER_ID = 'workbench.view.extension.backboard';

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// One-time repair for profiles whose saved layout orphaned the Chat panel.
		if (!this.storageService.getBoolean(ChatPanelResilienceContribution.REPAIR_STORAGE_KEY, StorageScope.PROFILE, false)) {
			this.storageService.store(ChatPanelResilienceContribution.REPAIR_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
			this.repairChatLocation();
		}

		// Ongoing: never leave the right bar visible-but-empty.
		this.healEmptyAuxiliaryBar();
		this.warmChatStrip();
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.AUXILIARYBAR_PART && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				this.healEmptyAuxiliaryBar();
				this.warmChatStrip();
			}
		}));
	}

	private warmedChatStrip = false;

	/**
	 * The session tab strip lives in the auxiliary bar's title row but is
	 * created by the chat pane (`mergeTabsIntoTitleBar`). If the bar restores
	 * with an agent panel (Claude Code, Codex) active before chat was ever
	 * opened, the strip does not exist and there is no way back to chat —
	 * Cursor always shows the strip in this state. Warm the chat composite
	 * once in the background, then restore the panel the user was on. Once the
	 * chat pane exists the strip survives composite switches, so this is a
	 * one-time repair per window.
	 */
	private warmChatStrip(): void {
		if (this.warmedChatStrip || !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return;
		}
		const active = this.paneCompositePartService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		if (!active || active.getId() === ChatViewContainerId || !isAgentPanelContainer(active.getId()) || !this.chatIsOnRight()) {
			return;
		}
		this.warmedChatStrip = true;
		const restoreId = active.getId();
		(async () => {
			await this.paneCompositePartService.openPaneComposite(ChatViewContainerId, ViewContainerLocation.AuxiliaryBar, false);
			await this.paneCompositePartService.openPaneComposite(restoreId, ViewContainerLocation.AuxiliaryBar, false);
		})();
	}

	/**
	 * Whether the right (auxiliary) bar is reserved for Chat — i.e. no *other*
	 * view container currently lives there. When some other view has been moved
	 * to the right, the user is arranging that space and Chat is left alone.
	 *
	 * Installed agent panels (Claude Code, Codex) are the exception: they are meant
	 * to sit on the right *alongside* Chat as sibling tabs, so their presence never
	 * means the user handed the right bar to something else.
	 */
	private rightIsReservedForChat(): boolean {
		return !this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar)
			.some(container => container.id !== ChatViewContainerId
				&& container.id !== ChatPanelResilienceContribution.LEGACY_BACKBOARD_CONTAINER_ID
				&& !isAgentPanelContainer(container.id));
	}

	/** Evicts the legacy Backboard extension container off the right, back to its default. */
	private evictLegacyBackboardFromRight(): void {
		const legacy = this.viewDescriptorService.getViewContainerById(ChatPanelResilienceContribution.LEGACY_BACKBOARD_CONTAINER_ID);
		if (legacy && this.viewDescriptorService.getViewContainerLocation(legacy) === ViewContainerLocation.AuxiliaryBar) {
			const home = this.viewDescriptorService.getDefaultViewContainerLocation(legacy) ?? ViewContainerLocation.Sidebar;
			if (home !== ViewContainerLocation.AuxiliaryBar) {
				this.viewDescriptorService.moveViewContainerToLocation(legacy, home, undefined, ChatPanelResilienceContribution.ID);
			}
		}
	}

	private chatIsOnRight(): boolean {
		const chat = this.viewDescriptorService.getViewContainerById(ChatViewContainerId);
		return !!chat && this.viewDescriptorService.getViewContainerLocation(chat) === ViewContainerLocation.AuxiliaryBar;
	}

	/** One-time: move an orphaned Chat container back to the right and reveal it. */
	private repairChatLocation(): void {
		if (!this.viewDescriptorService.canMoveViews()) {
			return;
		}
		// Undo the legacy layout experiment's damage first so the right reads as free.
		this.evictLegacyBackboardFromRight();
		const chat = this.viewDescriptorService.getViewContainerById(ChatViewContainerId);
		if (!chat || this.chatIsOnRight() || !this.rightIsReservedForChat()) {
			return;
		}
		this.viewDescriptorService.moveViewContainerToLocation(chat, ViewContainerLocation.AuxiliaryBar, undefined, ChatPanelResilienceContribution.ID);
		this.viewsService.openViewContainer(ChatViewContainerId, false);
	}

	/** Ongoing: if the right bar is visible but empty, fill it with Chat. */
	private healEmptyAuxiliaryBar(): void {
		if (!this.viewDescriptorService.canMoveViews()) {
			return;
		}
		if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return; // user closed it — respect that
		}
		if (this.paneCompositePartService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)) {
			return; // something is already shown there — respect the user's arrangement
		}
		const chat = this.viewDescriptorService.getViewContainerById(ChatViewContainerId);
		if (!chat) {
			return;
		}
		if (!this.chatIsOnRight()) {
			if (!this.rightIsReservedForChat()) {
				return;
			}
			this.viewDescriptorService.moveViewContainerToLocation(chat, ViewContainerLocation.AuxiliaryBar, undefined, ChatPanelResilienceContribution.ID);
		}
		this.viewsService.openViewContainer(ChatViewContainerId, false);
	}
}

registerWorkbenchContribution2(ChatPanelResilienceContribution.ID, ChatPanelResilienceContribution, WorkbenchPhase.AfterRestored);

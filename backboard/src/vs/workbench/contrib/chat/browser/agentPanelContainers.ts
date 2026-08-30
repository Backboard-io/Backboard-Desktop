/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewDescriptor, IViewDescriptorService, ViewContainerLocation, ViewVisibilityState } from '../../../common/views.js';
import { ChatViewContainerId } from './chat.js';

/**
 * An agent panel contributed by a marketplace extension — Claude Code, Codex — that
 * shares the right (auxiliary) bar with Backboard chat.
 *
 * Each one stays its own view container, a *peer* of the chat container rather than
 * a pane nested inside it. That is what makes the right bar behave like a set of
 * tabs: the auxiliary bar's composite bar lists every container that lives there,
 * and the selected one owns the whole surface.
 */
interface IAgentPanelContainer {

	/** Container the extension contributes to the secondary side bar (the modern path). */
	readonly containerId: string;

	/** Container it falls back to on hosts that do not support secondary side bar containers. */
	readonly fallbackContainerId: string;

	/** Views those containers own, used to undo an earlier build that merged them into chat. */
	readonly viewIds: readonly string[];
}

const agentPanelContainers: readonly IAgentPanelContainer[] = [
	{
		// anthropic.claude-code
		containerId: 'workbench.view.extension.claude-sidebar-secondary',
		fallbackContainerId: 'workbench.view.extension.claude-sidebar',
		viewIds: ['claudeVSCodeSidebarSecondary', 'claudeVSCodeSidebar']
	},
	{
		// openai.chatgpt
		containerId: 'workbench.view.extension.codexSecondaryViewContainer',
		fallbackContainerId: 'workbench.view.extension.codexViewContainer',
		viewIds: ['chatgpt.sidebarSecondaryView', 'chatgpt.sidebarView']
	}
];

const agentPanelContainerIds = new Set(agentPanelContainers.flatMap(panel => [panel.containerId, panel.fallbackContainerId]));
const agentPanelViewIds = new Set(agentPanelContainers.flatMap(panel => panel.viewIds));

/**
 * Whether the container is a known agent panel. Those belong on the right *next to*
 * chat, so they never count as the user having claimed the right bar for something
 * else (see `ChatPanelResilienceContribution`).
 */
export function isAgentPanelContainer(containerId: string): boolean {
	return agentPanelContainerIds.has(containerId);
}

/**
 * Keeps installed agent panels on the right, as tabs beside Backboard chat.
 *
 * Two jobs:
 *   1. Adopt: an agent panel that contributed itself to the activity bar (older
 *      extension versions, or hosts without secondary side bar support) is moved to
 *      the right once, then never again — a later move by the user sticks.
 *   2. Repair: an earlier build merged the Codex webview *into* the chat container,
 *      which stacked it under Backboard chat as a collapsible pane instead of giving
 *      it its own tab. That arrangement is persisted per profile, so it has to be
 *      actively undone by sending those views back to their own container.
 */
export class AgentPanelContainersContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentPanelContainers';

	private static readonly ADOPTED_STORAGE_KEY = 'agentPanels.adoptedContainers';

	private readonly adopted: Set<string>;
	private updating = false;

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.adopted = this.restoreAdopted();

		this.update();

		// Containers appear as their extensions activate, and views land in them a
		// moment later — both can reveal work for us to do.
		this._register(this.viewDescriptorService.onDidChangeViewContainers(() => this.update()));

		const chatViewContainer = this.viewDescriptorService.getViewContainerById(ChatViewContainerId);
		if (chatViewContainer) {
			const chatViewContainerModel = this.viewDescriptorService.getViewContainerModel(chatViewContainer);
			this._register(chatViewContainerModel.onDidChangeAllViewDescriptors(() => this.update()));
		}
	}

	private update(): void {
		if (this.updating) {
			return; // our own moves re-enter through the change events
		}

		this.updating = true;
		try {
			this.evictAgentViewsFromChat();
			this.adoptAgentPanelContainers();
		} finally {
			this.updating = false;
		}
	}

	/** Sends agent views that were merged into the chat container back to their own. */
	private evictAgentViewsFromChat(): void {
		if (!this.viewDescriptorService.canMoveViews()) {
			return;
		}

		for (const viewId of agentPanelViewIds) {
			if (this.viewDescriptorService.getViewContainerByViewId(viewId)?.id !== ChatViewContainerId) {
				continue;
			}

			const view: IViewDescriptor | null = this.viewDescriptorService.getViewDescriptorById(viewId);
			const home = this.viewDescriptorService.getDefaultContainerById(viewId);
			if (view && home && home.id !== ChatViewContainerId) {
				this.viewDescriptorService.moveViewsToContainer([view], home, ViewVisibilityState.Default, AgentPanelContainersContribution.ID);
			}
		}
	}

	/** Moves an agent panel that is not on the right yet over to the right, once per container. */
	private adoptAgentPanelContainers(): void {
		if (!this.viewDescriptorService.canMoveViews()) {
			return;
		}

		for (const containerId of agentPanelContainerIds) {
			if (this.adopted.has(containerId)) {
				continue;
			}

			const container = this.viewDescriptorService.getViewContainerById(containerId);
			if (!container) {
				continue; // not installed
			}

			if (this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
				this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, AgentPanelContainersContribution.ID);
			}

			this.markAdopted(containerId);
		}
	}

	private restoreAdopted(): Set<string> {
		try {
			const stored = this.storageService.get(AgentPanelContainersContribution.ADOPTED_STORAGE_KEY, StorageScope.PROFILE);
			if (stored) {
				return new Set<string>(JSON.parse(stored));
			}
		} catch {
			// corrupt entry — start over rather than never adopting again
		}

		return new Set<string>();
	}

	private markAdopted(containerId: string): void {
		this.adopted.add(containerId);
		this.storageService.store(AgentPanelContainersContribution.ADOPTED_STORAGE_KEY, JSON.stringify([...this.adopted]), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

registerWorkbenchContribution2(AgentPanelContainersContribution.ID, AgentPanelContainersContribution, WorkbenchPhase.AfterRestored);

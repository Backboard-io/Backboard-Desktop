/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { IManagedHoverContent } from '../../../../../../base/browser/ui/hover/hover.js';
import { HoverPosition } from '../../../../../../base/browser/ui/hover/hoverWidget.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { stripIcons } from '../../../../../../base/common/iconLabels.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { MenuEntryActionViewItem } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { ChatStatusEntry, IChatStatusItemService } from '../../chatStatus/chatStatusItemService.js';
import type { ChatInputPart, IBackboardUsageEventMetric, IBackboardUsageMetrics } from './chatInputPart.js';

const $ = dom.$;
const BACKBOARD_USAGE_METRICS_ACTION_ID = 'workbench.action.chat.backboardUsageMetrics';

interface IStatusActionDescriptor {
	readonly entryId: string;
	readonly manageCommandId: string;
	readonly manageLabel: string;
	/** Optional markdown title; overrides the contributed entry label. */
	readonly titleMarkdown?: string;
}

const OTEL_HOVER_TITLE_MARKDOWN = localize(
	'chat.inputStatus.otel.title',
	"Agent being monitored via [OpenTelemetry]({0})",
	''
);

const STATUS_COMMAND_DESCRIPTORS: ReadonlyMap<string, IStatusActionDescriptor> = new Map<string, IStatusActionDescriptor>([
	['github.copilot.chat.otel.statusActive', {
		entryId: 'copilot.otelStatus',
		manageCommandId: 'github.copilot.chat.otel.openSettings',
		manageLabel: localize('chat.inputStatus.otel.manageSettings', "Manage Settings"),
		titleMarkdown: OTEL_HOVER_TITLE_MARKDOWN,
	}],
	['github.copilot.chat.otel.statusCapturing', {
		entryId: 'copilot.otelStatus',
		manageCommandId: 'github.copilot.chat.otel.openSettings',
		manageLabel: localize('chat.inputStatus.otel.manageSettings', "Manage Settings"),
		titleMarkdown: OTEL_HOVER_TITLE_MARKDOWN,
	}],
]);

/**
 * Action view item for items contributed to MenuId.ChatInputStatus. Renders
 * a hover popup with the linked ChatStatusEntry detail and a "Manage" button.
 */
export class ChatInputStatusActionViewItem extends MenuEntryActionViewItem {

	private readonly _hoverContentDisposables = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		action: MenuItemAction,
		private readonly _inputPart: ChatInputPart | undefined,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IChatStatusItemService private readonly chatStatusItemService: IChatStatusItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		// Pin the hover popup above the pill, matching chat-in-progress mode.
		const hoverDelegate = instantiationService.createInstance(
			WorkbenchHoverDelegate,
			'element',
			undefined,
			{ position: { hoverPosition: HoverPosition.ABOVE } },
		);
		super(action, { hoverDelegate }, keybindingService, notificationService, contextKeyService, themeService, contextMenuService, accessibilityService);
		this._register(hoverDelegate);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		if (this._commandAction.id === BACKBOARD_USAGE_METRICS_ACTION_ID) {
			container.classList.add('backboard-usage-status-action');
			this.element?.classList.add('backboard-usage-status-control');
		}

		const descriptor = STATUS_COMMAND_DESCRIPTORS.get(this._commandAction.id);
		if (!descriptor) {
			return;
		}

		// Refresh the managed hover content when the contributed status entry changes
		this._register(this.chatStatusItemService.onDidChange(e => {
			if (e.entry.id === descriptor.entryId) {
				this.updateTooltip();
			}
		}));
	}

	override async onClick(event: MouseEvent): Promise<void> {
		if (this._commandAction.id === BACKBOARD_USAGE_METRICS_ACTION_ID && this._inputPart && this.element) {
			event.preventDefault();
			event.stopPropagation();
			this.hoverService.hideHover(true);
			this.hoverService.showInstantHover({
				content: this._renderBackboardUsageMetrics(),
				target: this.element,
				trapFocus: true,
				position: { hoverPosition: HoverPosition.ABOVE },
				appearance: { showPointer: true, compact: true },
			}, true);
			return;
		}

		return super.onClick(event);
	}

	protected override getHoverContents(): IManagedHoverContent | undefined {
		if (this._commandAction.id === BACKBOARD_USAGE_METRICS_ACTION_ID && this._inputPart) {
			return {
				element: () => this._renderBackboardUsageMetrics(),
			};
		}
		const descriptor = STATUS_COMMAND_DESCRIPTORS.get(this._commandAction.id);
		if (!descriptor) {
			return super.getHoverContents();
		}
		const entry = this._lookupEntry(descriptor.entryId);
		if (!entry) {
			return super.getHoverContents();
		}
		return {
			element: (_token: CancellationToken) => this._renderHoverContent(entry, descriptor),
		};
	}

	private _lookupEntry(entryId: string): ChatStatusEntry | undefined {
		for (const entry of this.chatStatusItemService.getEntries()) {
			if (entry.id === entryId) {
				return entry;
			}
		}
		return undefined;
	}

	private _renderBackboardUsageMetrics(): HTMLElement {
		const metrics = this._inputPart!.getBackboardUsageMetrics();
		const root = $('div.chat-input-status-hover-content.chat-input-status-hover.backboard-usage-metrics-hover');

		this._renderBackboardUsageMetricsInto(root, metrics);
		this._inputPart!.getBackboardRecentUsageMetrics().then(recentMetrics => {
			this._renderBackboardUsageMetricsInto(root, recentMetrics);
		}).catch(() => undefined);

		return root;
	}

	private _renderBackboardUsageMetricsInto(root: HTMLElement, metrics: IBackboardUsageMetrics): void {
		root.replaceChildren();

		const titleEl = root.appendChild($('div.chat-input-status-hover-title'));
		titleEl.textContent = metrics.title;

		const descEl = root.appendChild($('div.chat-input-status-hover-description'));
		descEl.textContent = metrics.description;

		const detailEl = root.appendChild($('div.chat-input-status-hover-detail.backboard-usage-summary-grid'));
		for (const row of metrics.rows) {
			const rowEl = detailEl.appendChild($('div.backboard-usage-summary-item'));
			rowEl.appendChild($('span.backboard-usage-summary-label', undefined, row.label));
			rowEl.appendChild($('span.backboard-usage-summary-value', undefined, row.value));
		}

		if (metrics.events?.length) {
			const eventsEl = root.appendChild($('div.backboard-usage-events'));
			for (const event of metrics.events) {
				eventsEl.appendChild(this._renderBackboardUsageEvent(event));
			}
		}
	}

	private _renderBackboardUsageEvent(event: IBackboardUsageEventMetric): HTMLElement {
		const root = $('div.backboard-usage-event');

		const header = root.appendChild($('div.backboard-usage-event-header'));
		header.appendChild($('div.backboard-usage-event-title', undefined, event.title));
		if (event.subtitle) {
			header.appendChild($('div.backboard-usage-event-subtitle', undefined, event.subtitle));
		}

		const rows = root.appendChild($('div.backboard-usage-event-rows'));
		for (const row of event.rows) {
			const rowEl = rows.appendChild($('div.backboard-usage-event-row'));
			rowEl.appendChild($('span.backboard-usage-event-row-label', undefined, row.label));
			rowEl.appendChild($('span.backboard-usage-event-row-value', undefined, row.value));
		}

		return root;
	}

	private _renderHoverContent(entry: ChatStatusEntry, descriptor: IStatusActionDescriptor): HTMLElement {
		const store = new DisposableStore();
		this._hoverContentDisposables.value = store;

		const root = $('div.chat-input-status-hover-content.chat-input-status-hover');

		const titleEl = root.appendChild($('div.chat-input-status-hover-title'));
		if (descriptor.titleMarkdown) {
			const rendered = store.add(this.markdownRendererService.render(new MarkdownString(descriptor.titleMarkdown, { isTrusted: false })));
			titleEl.appendChild(rendered.element);
		} else {
			titleEl.textContent = typeof entry.label === 'string' ? entry.label : entry.label.label;
		}

		if (entry.description) {
			const descEl = root.appendChild($('div.chat-input-status-hover-description'));
			descEl.append(...renderLabelWithIcons(entry.description));
			descEl.title = stripIcons(entry.description).trim();
		}

		if (entry.detail) {
			const detailEl = root.appendChild($('div.chat-input-status-hover-detail'));
			const rendered = store.add(this.markdownRendererService.render(new MarkdownString(entry.detail, { isTrusted: false, supportThemeIcons: true })));
			detailEl.appendChild(rendered.element);
		}

		const actionsRow = root.appendChild($('div.chat-input-status-hover-actions'));
		const manageButton = store.add(new Button(actionsRow, { ...defaultButtonStyles, secondary: true }));
		manageButton.label = descriptor.manageLabel;
		store.add(manageButton.onDidClick(() => {
			this.commandService.executeCommand(descriptor.manageCommandId);
			this.hoverService.hideHover(true);
		}));

		return root;
	}
}

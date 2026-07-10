/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../agentSessions/agentHost/media/agentHostChatInputPicker.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { Gesture, EventType as TouchEventType } from '../../../../../../base/browser/touch.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { BaseActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { resolveConfigProperty } from './chatModelPicker.js';
import { IModelConfigurationAccess, IModelPickerDelegate } from './modelPickerActionItem.js';

interface IThinkingPickerItem {
	readonly value: unknown;
	readonly label: string;
	readonly description?: string;
}

/**
 * Composer chip surfacing the active model's thinking / intensity level
 * directly in the input toolbar (next to the model picker), instead of only
 * inside the model dropdown's hover flyout. Reads and writes the same
 * per-editor model configuration the model picker uses
 * ({@link IModelPickerDelegate.modelConfiguration}), so the two stay in sync.
 *
 * Self-hides when the active model advertises no navigation-group enum
 * config (e.g. Haiku, which has no thinking levels).
 */
export class ChatThinkingPickerActionItem extends BaseActionViewItem {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;

	constructor(
		action: IAction,
		private readonly _delegate: IModelPickerDelegate,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IActionWidgetService private readonly _actionWidgetService: IActionWidgetService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super(undefined, action);
		this._register(autorun(reader => {
			this._delegate.currentModel.read(reader);
			this._renderChip();
		}));
		const onDidChangeConfig = this._delegate.modelConfiguration?.onDidChange;
		if (onDidChangeConfig) {
			this._register(onDidChangeConfig(() => this._renderChip()));
		}
	}

	private get _configAccess(): IModelConfigurationAccess {
		return this._delegate.modelConfiguration ?? this._languageModelsService;
	}

	override render(container: HTMLElement): void {
		this._container = container;
		container.classList.add('agent-host-chat-input-picker-host', 'chat-thinking-picker-item');
		this._renderChip();
	}

	private _renderChip(): void {
		const container = this._container;
		if (!container) {
			return;
		}
		this._renderDisposables.clear();
		dom.clearNode(container);

		const model = this._delegate.currentModel.get();
		const prop = model ? resolveConfigProperty(model, 'navigation', this._configAccess) : undefined;
		if (!model || !prop) {
			container.style.display = 'none';
			return;
		}
		container.style.display = '';

		const slot = dom.append(container, dom.$('.agent-host-chat-input-picker-slot'));
		this._renderDisposables.add({ dispose: () => slot.remove() });
		const trigger = dom.append(slot, dom.$('a.action-label'));
		trigger.role = 'button';
		trigger.tabIndex = 0;
		trigger.setAttribute('aria-haspopup', 'listbox');

		dom.append(trigger, renderIcon(Codicon.lightbulb));
		const label = this._labelFor(prop, prop.value);
		const labelSpan = dom.append(trigger, dom.$('span.agent-host-chat-input-picker-label'));
		labelSpan.textContent = label;
		const ariaLabel = localize('chatThinkingPicker.triggerAria', "Thinking Level: {0}", label);
		trigger.setAttribute('aria-label', ariaLabel);
		trigger.dataset.configProperty = 'thinkingLevel';
		trigger.dataset.configValue = String(prop.value ?? '');
		this._renderDisposables.add(this._hoverService.setupDelayedHover(trigger, {
			content: localize('chatThinkingPicker.hover', "Controls how much reasoning effort {0} uses.", model.metadata.name),
		}));

		this._renderDisposables.add(Gesture.addTarget(trigger));
		for (const eventType of [dom.EventType.CLICK, TouchEventType.Tap]) {
			this._renderDisposables.add(dom.addDisposableListener(trigger, eventType, e => {
				dom.EventHelper.stop(e, true);
				this._showPicker(trigger, model);
			}));
		}
		this._renderDisposables.add(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				this._showPicker(trigger, model);
			}
		}));
	}

	private _labelFor(prop: { schema: { enum?: unknown[]; enumItemLabels?: string[] } }, value: unknown): string {
		const index = prop.schema.enum?.indexOf(value) ?? -1;
		return prop.schema.enumItemLabels?.[index] ?? String(value ?? '');
	}

	/** Whether the active model currently advertises a thinking-level control. */
	hasThinkingLevel(): boolean {
		const model = this._delegate.currentModel.get();
		return !!model && !!resolveConfigProperty(model, 'navigation', this._configAccess);
	}

	/** Current thinking-level label, or `undefined` when the active model has none. */
	getCurrentLabel(): string | undefined {
		const model = this._delegate.currentModel.get();
		const prop = model ? resolveConfigProperty(model, 'navigation', this._configAccess) : undefined;
		return prop ? this._labelFor(prop, prop.value) : undefined;
	}

	/** Opens the picker anchored to `anchor`, for reuse from another widget's dropdown (e.g. the consolidated Claude options gear). */
	show(anchor: HTMLElement): void {
		const model = this._delegate.currentModel.get();
		if (model) {
			this._showPicker(anchor, model);
		}
	}

	private _showPicker(trigger: HTMLElement, model: ILanguageModelChatMetadataAndIdentifier): void {
		if (this._actionWidgetService.isVisible) {
			return;
		}
		const prop = resolveConfigProperty(model, 'navigation', this._configAccess);
		if (!prop || !prop.schema.enum?.length) {
			return;
		}
		const items: IActionListItem<IThinkingPickerItem>[] = prop.schema.enum.map((value, index) => {
			const label = prop.schema.enumItemLabels?.[index] ?? String(value);
			const selected = value === prop.value;
			return {
				kind: ActionListItemKind.Action,
				label,
				detail: prop.schema.enumDescriptions?.[index],
				group: { title: '', icon: Codicon.lightbulb },
				item: {
					value,
					label: selected ? localize('chatThinkingPicker.selected', "{0} (Selected)", label) : label,
					description: prop.schema.enumDescriptions?.[index],
				},
			};
		});

		const delegate: IActionListDelegate<IThinkingPickerItem> = {
			onSelect: item => {
				this._actionWidgetService.hide();
				void this._configAccess.setModelConfiguration(model.identifier, { [prop.key]: item.value });
			},
			onHide: () => trigger.focus(),
		};

		this._actionWidgetService.show<IThinkingPickerItem>(
			'chatThinkingPicker',
			false,
			items,
			delegate,
			trigger,
			undefined,
			[],
			{
				getAriaLabel: item => item.label ?? '',
				getWidgetAriaLabel: () => localize('chatThinkingPicker.ariaLabel', "Thinking Level Picker"),
			},
		);
	}
}

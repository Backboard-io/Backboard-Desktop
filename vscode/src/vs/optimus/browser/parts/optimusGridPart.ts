/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/optimusGridPart.css';
import { $, append } from '../../../base/browser/dom.js';
import { ProgressBar } from '../../../base/browser/ui/progressbar/progressbar.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { defaultProgressBarStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Part } from '../../../workbench/browser/part.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { AbstractProgressScope, ScopedProgressIndicator } from '../../../workbench/services/progress/browser/progressIndicator.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground } from '../../../sessions/common/theme.js';
import { IActiveSession } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { OptimusCard } from './optimusCard.js';

export const OPTIMUS_NEW_SESSION_COMMAND_ID = 'optimus.newSession';

/**
 * Main content part of the Optimus window: a fixed 3-column x 2-row grid of
 * six compact task cards. A passive renderer in the same sense as the Simple
 * window's SessionsPart — the sessions service drives it via
 * {@link updateVisibleSessions}, and card focus/clicks are reported back via
 * {@link onDidFocusSession}.
 */
export class OptimusGridPart extends Part {

	static readonly SLOT_COUNT = 6;

	override readonly minimumWidth: number = 300;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	private readonly cards: OptimusCard[] = [];
	private gridContainer: HTMLElement | undefined;
	private progressBar: ProgressBar | undefined;
	private progressIndicator: IProgressIndicator | undefined;

	private readonly _onDidFocusSession = this._register(new Emitter<string>());
	readonly onDidFocusSession: Event<string> = this._onDidFocusSession.event;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(
			Parts.SESSIONS_PART,
			{ hasTitle: false, borderWidth: () => 0 },
			themeService,
			storageService,
			layoutService
		);
	}

	override create(parent: HTMLElement): void {
		// The workbench grid reads `part.element`; the Part base does not set it.
		this.element = parent;
		super.create(parent);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const contentArea = append(parent, $('.content.optimus-grid-content'));

		this.progressBar = this._register(new ProgressBar(contentArea, defaultProgressBarStyles));
		this.progressBar.hide();

		this.gridContainer = append(contentArea, $('.optimus-grid'));

		for (let i = 0; i < OptimusGridPart.SLOT_COUNT; i++) {
			const card = this._register(this.instantiationService.createInstance(OptimusCard, this.gridContainer));
			this._register(card.onDidClick(session => {
				if (session) {
					// The sessions service listens and promotes to the active session.
					this._onDidFocusSession.fire(session.sessionId);
				} else {
					// Injecting ISessionsService here would recurse (it injects
					// ISessionsPartService, which constructs this part), so the
					// placeholder routes through a command instead.
					this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
				}
			}));
			this.cards.push(card);
		}

		return contentArea;
	}

	/**
	 * Reconcile the six fixed slots against the service's visible sessions.
	 * Sessions beyond the sixth slot are not rendered.
	 */
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		for (let i = 0; i < this.cards.length; i++) {
			const session = visible[i];
			this.cards[i].bind(session, !!session && session.sessionId === active?.sessionId);
		}
	}

	focusSession(session: IActiveSession | undefined): void {
		const card = session
			? this.cards.find(c => c.session?.sessionId === session.sessionId)
			: this.cards.find(c => !c.session);
		card?.focus();
	}

	getProgressIndicator(): IProgressIndicator {
		if (!this.progressIndicator) {
			const progressBar = assertReturnsDefined(this.progressBar);
			const scopeId = Parts.SESSIONS_PART;
			const isVisible = this.layoutService.isVisible(scopeId);
			const onDidVisibilityChange = this.onDidVisibilityChange;
			const scope = this._register(new class extends AbstractProgressScope {
				constructor() {
					super(scopeId, isVisible);
					this._register(onDidVisibilityChange(visible => visible ? this.onScopeOpened(scopeId) : this.onScopeClosed(scopeId)));
				}
			}());
			this.progressIndicator = this._register(new ScopedProgressIndicator(progressBar, scope));
		}
		return this.progressIndicator;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		super.layoutContents(width, height);
	}

	toJSON(): object {
		return {
			type: Parts.SESSIONS_PART
		};
	}
}

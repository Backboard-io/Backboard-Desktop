/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SkillsLibraryController } from '../../../../workbench/contrib/chat/browser/widget/input/skillsLibrary.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

/** A full-page catalog on Simple mode's session surface, which remains visible while editors are hidden. */
export class SimpleMcpPage extends Disposable {
	private readonly page = this._register(new MutableDisposable<DisposableStore>());
	private readonly visibilityEmitter = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this.visibilityEmitter.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ISessionsService sessionsService: ISessionsService,
	) {
		super();
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			session?.activeChat.read(reader);
			this.hide();
		}));
	}

	show(anchor: HTMLElement): void {
		const host = this.layoutService.getContainer(getWindow(anchor), Parts.SESSIONS_PART);
		if (!host) {
			return;
		}
		if (this.page.value) {
			host.querySelector<HTMLInputElement>('.simple-mcp-page input')?.focus();
			return;
		}
		const store = new DisposableStore();
		this.page.value = store;
		const surface = append(host, $('.simple-mcp-page', { 'aria-label': localize('simpleMcp.title', "MCPs"), role: 'region' }));
		host.classList.add('simple-mcp-page-open');
		store.add(toDisposable(() => {
			surface.remove();
			host.classList.remove('simple-mcp-page-open');
			this.visibilityEmitter.fire(false);
		}));
		store.add(this.instantiationService.createInstance(SkillsLibraryController).renderEmbeddedMarketplace(surface, true));
		const back = append(surface, $('button.simple-mcp-page-back.simple-mcp-icon-button', { type: 'button', 'aria-label': localize('simpleMcp.backToChat', "Back to chat") }, renderIcon(Codicon.arrowLeft)));
		const close = () => {
			this.hide();
			anchor.focus();
		};
		store.add(addDisposableListener(back, EventType.CLICK, close));
		store.add(addDisposableListener(surface, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				event.stopPropagation();
				close();
			}
		}));
		this.visibilityEmitter.fire(true);
	}

	hide(): void {
		this.page.clear();
	}
}

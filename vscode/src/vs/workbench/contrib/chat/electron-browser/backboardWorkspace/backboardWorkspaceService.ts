/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { BACKBOARD_WORKSPACE_OPEN_ON_STARTUP_STORAGE_KEY } from './backboardWorkspaceConstants.js';
import { BackboardWorkspacePage } from './backboardWorkspacePage.js';

export const IBackboardWorkspaceService = createDecorator<IBackboardWorkspaceService>('backboardWorkspaceService');

const BACKBOARD_WORKSPACE_VISIBLE_CLASS = 'backboard-workspace-visible';

export interface IBackboardWorkspaceService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeVisibility: Event<boolean>;
	readonly visible: boolean;
	show(): void;
	hide(): void;
}

export class BackboardWorkspaceService extends Disposable implements IBackboardWorkspaceService {

	declare readonly _serviceBrand: undefined;

	private container: HTMLElement | undefined;
	private readonly page = this._register(new MutableDisposable<BackboardWorkspacePage>());
	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

	private _visible = false;
	get visible(): boolean {
		return this._visible;
	}

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._register(this.layoutService.onDidLayoutMainContainer(dimension => {
			this.layout(Dimension.lift(dimension));
		}));

		if (this.storageService.getBoolean(BACKBOARD_WORKSPACE_OPEN_ON_STARTUP_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			this.storageService.remove(BACKBOARD_WORKSPACE_OPEN_ON_STARTUP_STORAGE_KEY, StorageScope.APPLICATION);
			this._register(disposableTimeout(() => this.show()));
		}
	}

	show(): void {
		this.ensureCreated();

		if (!this._visible) {
			this._visible = true;
			this.layoutService.mainContainer.classList.add(BACKBOARD_WORKSPACE_VISIBLE_CLASS);
			this.container?.classList.remove('hidden');
			this.layout(Dimension.lift(this.layoutService.mainContainerDimension));
			this.page.value?.revealTop();
			this._onDidChangeVisibility.fire(true);
		}

		this.page.value?.focus();
		this.page.value?.revealTop();
	}

	hide(): void {
		if (!this._visible) {
			return;
		}

		this._visible = false;
		this.layoutService.mainContainer.classList.remove(BACKBOARD_WORKSPACE_VISIBLE_CLASS);
		this.container?.classList.add('hidden');
		this._onDidChangeVisibility.fire(false);
	}

	private ensureCreated(): void {
		if (this.container) {
			return;
		}

		this.container = append(this.layoutService.mainContainer, $('.backboard-workspace-surface.hidden'));
		this._register(toDisposable(() => {
			this.layoutService.mainContainer.classList.remove(BACKBOARD_WORKSPACE_VISIBLE_CLASS);
			this.container?.remove();
		}));

		const page = this.instantiationService.createInstance(BackboardWorkspacePage);
		page.create(this.container);
		this.page.value = page;
	}

	private layout(dimension: Dimension): void {
		if (!this.container) {
			return;
		}

		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
		this.page.value?.layout(dimension);
	}
}

registerSingleton(IBackboardWorkspaceService, BackboardWorkspaceService, InstantiationType.Delayed);

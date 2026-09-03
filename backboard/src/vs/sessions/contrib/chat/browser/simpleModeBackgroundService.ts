/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const SIMPLE_MODE_BACKGROUND_IMAGE_STORAGE_KEY = 'sessions.simpleMode.backgroundImage';

export const SimpleModeBackgroundImageSetContext = new RawContextKey<boolean>(
	'sessionsSimpleModeBackgroundImageSet',
	false,
	localize('sessionsSimpleModeBackgroundImageSet', "Whether Simple mode has a custom background image")
);

export const ISimpleModeBackgroundService = createDecorator<ISimpleModeBackgroundService>('simpleModeBackgroundService');

export interface ISimpleModeBackgroundService {
	readonly _serviceBrand: undefined;

	readonly backgroundImage: URI | undefined;
	/** Increments whenever the background is applied, including a re-selection of the same file. */
	readonly backgroundImageRevision: number;
	readonly onDidChangeBackgroundImage: Event<URI | undefined>;

	chooseBackgroundImage(): Promise<void>;
	clearBackgroundImage(): void;
}

/**
 * Owns the machine-local background image selected for Simple mode's new-chat
 * canvas. Only the URI is persisted; the source image remains in its original
 * location so replacing the file also updates the background.
 */
export class SimpleModeBackgroundService extends Disposable implements ISimpleModeBackgroundService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeBackgroundImage = this._register(new Emitter<URI | undefined>());
	readonly onDidChangeBackgroundImage = this._onDidChangeBackgroundImage.event;

	private readonly backgroundImageSetContext: IContextKey<boolean>;
	private _backgroundImage: URI | undefined;
	private _backgroundImageRevision = 0;
	private pendingChooseBackgroundImage: Promise<void> | undefined;

	get backgroundImage(): URI | undefined {
		return this._backgroundImage;
	}

	get backgroundImageRevision(): number {
		return this._backgroundImageRevision;
	}

	constructor(
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this.backgroundImageSetContext = SimpleModeBackgroundImageSetContext.bindTo(contextKeyService);
		this.restoreBackgroundImage();
		this._register(this.storageService.onDidChangeValue(
			StorageScope.PROFILE,
			SIMPLE_MODE_BACKGROUND_IMAGE_STORAGE_KEY,
			this._store
		)(() => this.restoreBackgroundImage()));
	}

	chooseBackgroundImage(): Promise<void> {
		// Native file pickers are asynchronous. Keep a second click from opening a
		// competing picker whose later result can overwrite the newer selection.
		if (this.pendingChooseBackgroundImage) {
			return this.pendingChooseBackgroundImage;
		}

		let request: Promise<void>;
		request = this.doChooseBackgroundImage().finally(() => {
			if (this.pendingChooseBackgroundImage === request) {
				this.pendingChooseBackgroundImage = undefined;
			}
		});
		this.pendingChooseBackgroundImage = request;
		return request;
	}

	private async doChooseBackgroundImage(): Promise<void> {
		const selected = await this.fileDialogService.showOpenDialog({
			title: localize('simpleModeBackground.chooseTitle', "Choose a Simple Mode Background Image"),
			openLabel: localize('simpleModeBackground.useImage', "Use Image"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{
				name: localize('simpleModeBackground.imageFiles', "Image Files"),
				extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
			}],
		});

		const resource = selected?.[0];
		if (!resource) {
			return;
		}

		// Force an update when the same file is picked again. This is useful after
		// replacing an image on disk and prevents the canvas from appearing stuck.
		this.setBackgroundImage(resource, true);
		this.storageService.store(
			SIMPLE_MODE_BACKGROUND_IMAGE_STORAGE_KEY,
			resource.toString(),
			StorageScope.PROFILE,
			StorageTarget.MACHINE
		);
	}

	clearBackgroundImage(): void {
		this.setBackgroundImage(undefined);
		this.storageService.remove(SIMPLE_MODE_BACKGROUND_IMAGE_STORAGE_KEY, StorageScope.PROFILE);
	}

	private restoreBackgroundImage(): void {
		const stored = this.storageService.get(SIMPLE_MODE_BACKGROUND_IMAGE_STORAGE_KEY, StorageScope.PROFILE);
		if (!stored) {
			this.setBackgroundImage(undefined);
			return;
		}

		try {
			this.setBackgroundImage(URI.parse(stored));
		} catch {
			this.setBackgroundImage(undefined);
		}
	}

	private setBackgroundImage(resource: URI | undefined, force = false): void {
		if (!force && this._backgroundImage?.toString() === resource?.toString()) {
			return;
		}

		this._backgroundImage = resource;
		this._backgroundImageRevision++;
		this.backgroundImageSetContext.set(!!resource);
		this._onDidChangeBackgroundImage.fire(resource);
	}
}

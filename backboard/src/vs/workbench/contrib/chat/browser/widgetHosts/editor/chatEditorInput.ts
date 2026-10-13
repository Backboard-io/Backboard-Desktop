/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { revive } from '../../../../../../base/common/marshalling.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { truncate } from '../../../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import * as nls from '../../../../../../nls.js';
import { ConfirmResult, IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { registerIcon } from '../../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorIdentifier, IEditorSerializer, IUntypedEditorInput, Verbosity } from '../../../../../common/editor.js';
import { EditorInput, IEditorCloseHandler } from '../../../../../common/editor/editorInput.js';
import { IChatModelReference, IChatService } from '../../../common/chatService/chatService.js';
import { IChatSessionsService, localChatSessionType } from '../../../common/chatSessionsService.js';
import { ChatAgentLocation, ChatEditorTitleMaxLength, getDefaultNewChatSessionResource, getDefaultNewChatSessionType } from '../../../common/constants.js';
import { IChatEditingSession, ModifiedFileEntryState } from '../../../common/editing/chatEditingService.js';
import { isChatPerfLoggingEnabled, logChatPerf } from '../../../common/chatPerf.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { LocalChatSessionUri, getChatSessionType } from '../../../common/model/chatUri.js';
import { IClearEditingSessionConfirmationOptions } from '../../actions/chatActions.js';
import type { IChatEditorOptions } from './chatEditor.js';

const ChatEditorIcon = registerIcon('chat-editor-label-icon', ThemeIcon.fromId('backboard-logo'), nls.localize('chatEditorLabelIcon', 'Icon of the chat editor label.'));
const InactiveChatEditorModelReleaseDelay = 5_000;

export class ChatEditorInput extends EditorInput implements IEditorCloseHandler {
	static readonly TypeID: string = 'workbench.input.chatSession';
	static readonly EditorID: string = 'workbench.editor.chatSession';

	private _sessionResource: URI | undefined;

	/**
	 * Get the uri of the session this editor input is associated with.
	 *
	 * This should be preferred over using `resource` directly, as it handles cases where a chat editor becomes a session
	 */
	public get sessionResource(): URI | undefined { return this._sessionResource; }

	private didTransferOutEditingSession = false;
	private cachedIcon: ThemeIcon | URI | undefined;
	private cachedName: string | undefined;

	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly _modelChangeListener = this._register(new MutableDisposable());
	private readonly _modelAdapter = this._register(new MutableDisposable<ChatEditorModel>());
	private readonly _inactiveModelRelease = this._register(new MutableDisposable<IDisposable>());
	private _modelWasReleased = false;
	private _releaseWhenIdle = false;
	private _resolvePromise: Promise<ChatEditorModel | null> | undefined;
	private _modelReferenceGeneration = 0;

	private get model(): IChatModel | undefined {
		return this.modelRef.value?.object;
	}

	get needsModelRestore(): boolean {
		return this._modelWasReleased;
	}

	get hasModelReferenceOrPendingResolve(): boolean {
		return !!this.model || !!this._resolvePromise;
	}

	markModelReferenceActive(): void {
		this._releaseWhenIdle = false;
		this._inactiveModelRelease.clear();
	}

	scheduleModelReferenceRelease(delay = InactiveChatEditorModelReleaseDelay): void {
		if (this._modelWasReleased || this.isDisposed()) {
			return;
		}
		this._releaseWhenIdle = true;
		this._inactiveModelRelease.clear();
		this._scheduleInactiveModelRelease(delay, 'timeout');
		if (isChatPerfLoggingEnabled(this.logService)) {
			logChatPerf(this.logService, 'editor.scheduleInactiveInputRelease', {
				session: this.sessionResource?.toString(),
				delayMs: delay,
			});
		}
	}

	private _scheduleInactiveModelRelease(delay: number, reason: 'timeout' | 'retry'): void {
		if (!this._releaseWhenIdle || this._modelWasReleased || this.isDisposed() || this._inactiveModelRelease.value) {
			return;
		}
		this._inactiveModelRelease.value = disposableTimeout(() => {
			this._inactiveModelRelease.clear();
			this._tryReleaseInactiveModelReference(reason);
		}, delay);
	}

	canReleaseModelReference(): boolean {
		const model = this.model;
		if (!model || model.requestInProgress.get() || model.requestNeedsInput.get()) {
			return false;
		}
		return !model.editingSession?.entries.get().some(entry => entry.state.get() === ModifiedFileEntryState.Modified);
	}

	releaseModelReference(): boolean {
		if (!this.canReleaseModelReference()) {
			return false;
		}
		this._modelReferenceGeneration++;
		this._releaseWhenIdle = false;
		this._inactiveModelRelease.clear();
		this.cachedName = this.model?.hasCustomTitle ? this.model.title : this.model?.title ? truncate(this.model.title, ChatEditorTitleMaxLength) : this.cachedName;
		this._modelChangeListener.clear();
		this._modelAdapter.clear();
		this.modelRef.clear();
		this._modelWasReleased = true;
		return true;
	}

	private _tryReleaseInactiveModelReference(reason: 'timeout' | 'retry'): void {
		if (!this._releaseWhenIdle || this.isDisposed()) {
			return;
		}
		const released = this.releaseModelReference();
		if (isChatPerfLoggingEnabled(this.logService)) {
			logChatPerf(this.logService, 'editor.inactiveInputRelease', {
				session: this.sessionResource?.toString(),
				reason,
				released,
			}, undefined);
		}
		if (!released && this._releaseWhenIdle) {
			// A request, user-input pause, or modified edit can make the model
			// temporarily ineligible. Poll at a low frequency because ChatModel does
			// not emit a general completion event for every request lifecycle.
			if (this.model || this._resolvePromise) {
				this._scheduleInactiveModelRelease(InactiveChatEditorModelReleaseDelay, 'retry');
			} else {
				// There is no acquired or pending reference, so there is nothing left
				// for this release request to own.
				this._releaseWhenIdle = false;
			}
		}
	}

	static getNewEditorUri(): URI {
		return ChatEditorUri.getNewEditorUri();
	}

	constructor(
		readonly resource: URI,
		readonly options: IChatEditorOptions,
		@IChatService private readonly chatService: IChatService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (resource.scheme === Schemas.vscodeChatEditor) {
			const parsed = ChatEditorUri.parse(resource);
			if (!parsed || typeof parsed !== 'number') {
				throw new Error('Invalid chat URI');
			}
		} else if (resource.scheme === Schemas.vscodeLocalChatSession) {
			const localSessionId = LocalChatSessionUri.parseLocalSessionId(resource);
			if (!localSessionId) {
				throw new Error('Invalid local chat session URI');
			}
			this._sessionResource = resource;
		} else {
			this._sessionResource = resource;
		}
	}

	override closeHandler = this;

	showConfirm(): boolean {
		return !!(this.model && shouldShowClearEditingSessionConfirmation(this.model));
	}

	transferOutEditingSession(): IChatEditingSession | undefined {
		this.didTransferOutEditingSession = true;
		return this.model?.editingSession;
	}

	async confirm(editors: ReadonlyArray<IEditorIdentifier>): Promise<ConfirmResult> {
		if (!this.model?.editingSession || this.didTransferOutEditingSession || this.getSessionType() !== localChatSessionType) {
			return ConfirmResult.SAVE;
		}

		const titleOverride = nls.localize('chatEditorConfirmTitle', "Close Chat Editor");
		const messageOverride = nls.localize('chat.startEditing.confirmation.pending.message.default', "Closing the chat editor will end your current edit session.");
		const result = await showClearEditingSessionConfirmation(this.model, this.dialogService, { titleOverride, messageOverride });
		return result ? ConfirmResult.SAVE : ConfirmResult.CANCEL;
	}

	override get editorId(): string | undefined {
		return ChatEditorInput.EditorID;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.ForceReveal | EditorInputCapabilities.CanDropIntoEditor;
	}

	override copy(): EditorInput {
		return this.instantiationService.createInstance(ChatEditorInput, ChatEditorInput.getNewEditorUri(), {});
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (!(otherInput instanceof ChatEditorInput)) {
			return false;
		}

		if (this.sessionResource && otherInput.sessionResource) {
			return isEqual(this.sessionResource, otherInput.sessionResource);
		}

		return isEqual(this.resource, otherInput.resource);
	}

	override get typeId(): string {
		return ChatEditorInput.TypeID;
	}

	override getName(): string {
		// If we have a resolved model, use its title
		if (this.model?.title) {
			// Only truncate if the default title is being used (don't truncate custom titles)
			return this.model.hasCustomTitle ? this.model.title : truncate(this.model.title, ChatEditorTitleMaxLength);
		}
		if (this.cachedName) {
			return this.cachedName;
		}

		// If we have a sessionId but no resolved model, try to get the title from persisted sessions
		if (this._sessionResource) {
			// First try the active session registry
			const existingSession = this.chatService.getSession(this._sessionResource);
			if (existingSession?.title) {
				return existingSession.title;
			}

			// If not in active registry, try persisted session data
			const persistedTitle = this.chatService.getSessionTitle(this._sessionResource);
			if (persistedTitle && persistedTitle.trim()) { // Only use non-empty persisted titles
				return persistedTitle;
			}
		}

		// If a preferred title was provided in options, use it
		if (this.options.title?.preferred) {
			return this.options.title.preferred;
		}

		// Fall back to default naming pattern
		return this.options.title?.fallback ?? nls.localize('chatEditorName', "Chat");
	}

	override getTitle(verbosity?: Verbosity): string {
		const name = this.getName();
		if (verbosity === Verbosity.LONG) { // Verbosity LONG is used for tooltips
			const sessionTypeDisplayName = this.getSessionTypeDisplayName();
			if (sessionTypeDisplayName) {
				return `${name} | ${sessionTypeDisplayName}`;
			}
		}
		return name;
	}

	private getSessionTypeDisplayName(): string | undefined {
		const sessionType = this.getSessionType();
		if (sessionType === localChatSessionType) {
			return;
		}
		const contributions = this.chatSessionsService.getAllChatSessionContributions();
		const contribution = contributions.find(c => c.type === sessionType);
		return contribution?.displayName;
	}

	override getIcon(): ThemeIcon | URI | undefined {
		const resolvedIcon = this.resolveIcon();
		if (resolvedIcon) {
			this.cachedIcon = resolvedIcon;
			return resolvedIcon;
		}

		// Fall back to default icon
		return ChatEditorIcon;
	}

	private resolveIcon(): ThemeIcon | URI | undefined {
		// TODO@osortega,@rebornix double check: Chat Session Item icon is reserved for chat session list and deprecated for chat session status. thus here we use session type icon. We may want to show status for the Editor Title.
		const sessionType = this.getSessionType();
		if (sessionType !== localChatSessionType) {
			return this.chatSessionsService.getChatSessionContribution(sessionType)?.icon;
		}

		return undefined;
	}

	/**
	 * Returns chat session type from a URI, or {@linkcode localChatSessionType} if not specified or cannot be determined.
	 */
	public getSessionType(): string {
		return getChatSessionType(this._sessionResource ?? this.resource);
	}

	override resolve(): Promise<ChatEditorModel | null> {
		this.markModelReferenceActive();
		if (this.isDisposed()) {
			return Promise.resolve(null);
		}

		const existingAdapter = this._getCurrentModelAdapter();
		if (existingAdapter) {
			return Promise.resolve(existingAdapter);
		}

		let resolvePromise = this._resolvePromise;
		if (!resolvePromise) {
			resolvePromise = this._resolveModel(this._modelReferenceGeneration);
			this._resolvePromise = resolvePromise;
			const onSettled = () => {
				if (this._resolvePromise !== resolvePromise) {
					return;
				}
				this._resolvePromise = undefined;
				if (this._releaseWhenIdle) {
					this._scheduleInactiveModelRelease(InactiveChatEditorModelReleaseDelay, 'retry');
				}
			};
			void resolvePromise.then(onSettled, onSettled);
		}

		return resolvePromise;
	}

	private async _resolveModel(resolveGeneration: number): Promise<ChatEditorModel | null> {
		const searchParams = new URLSearchParams(this.resource.query);
		const chatSessionType = searchParams.get('chatSessionType');
		const inputType = chatSessionType ?? this.resource.authority;

		if (this._sessionResource) {
			if (!this._setModelReference(await this.chatService.acquireOrLoadSession(this._sessionResource, ChatAgentLocation.Chat, CancellationToken.None, 'ChatEditorInput#resolve'), resolveGeneration)) {
				return this._getCurrentModelAdapter();
			}

			if (this.shouldReplaceEmptyLocalSession(this._sessionResource)) {
				const defaultResource = getDefaultNewChatSessionResource(this.configurationService, this.chatSessionsService);
				if (getChatSessionType(defaultResource) !== localChatSessionType) {
					this._sessionResource = defaultResource;
					if (!this._setModelReference(await this.chatService.acquireOrLoadSession(defaultResource, ChatAgentLocation.Chat, CancellationToken.None, 'ChatEditorInput#resolveDefaultSession'), resolveGeneration)) {
						return this._getCurrentModelAdapter();
					}
				}
			}

			// For local session only, if we find no existing session, create a new one
			if (!this.model && LocalChatSessionUri.parseLocalSessionId(this._sessionResource)) {
				if (!this._setModelReference(this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { canUseTools: true, debugOwner: 'ChatEditorInput#resolveNewLocalSession' }), resolveGeneration)) {
					return this._getCurrentModelAdapter();
				}
			}
		} else if (!this.options.target) {
			const defaultResource = getDefaultNewChatSessionResource(this.configurationService, this.chatSessionsService);
			if (getChatSessionType(defaultResource) === localChatSessionType) {
				if (!this._setModelReference(this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { canUseTools: !inputType, debugOwner: 'ChatEditorInput#resolveUntitled' }), resolveGeneration)) {
					return this._getCurrentModelAdapter();
				}
			} else {
				this._sessionResource = defaultResource;
				if (!this._setModelReference(await this.chatService.acquireOrLoadSession(defaultResource, ChatAgentLocation.Chat, CancellationToken.None, 'ChatEditorInput#resolveDefaultUntitled'), resolveGeneration)) {
					return this._getCurrentModelAdapter();
				}
			}
		} else if (this.options.target.data) {
			if (!this._setModelReference(this.chatService.loadSessionFromData(this.options.target.data, 'ChatEditorInput#resolveImportedData'), resolveGeneration)) {
				return this._getCurrentModelAdapter();
			}
		}

		if (!this.model || this.isDisposed()) {
			return null;
		}

		this._sessionResource = this.model.sessionResource;
		this._modelWasReleased = false;
		this.cachedName = this.model.hasCustomTitle ? this.model.title : truncate(this.model.title, ChatEditorTitleMaxLength);

		this._trackModelChanges();

		// Check if icon has changed after model resolution
		const newIcon = this.resolveIcon();
		if (newIcon && (!this.cachedIcon || !this.iconsEqual(this.cachedIcon, newIcon))) {
			this.cachedIcon = newIcon;
		}

		this._onDidChangeLabel.fire();

		const modelAdapter = new ChatEditorModel(this.model);
		this._modelAdapter.value = modelAdapter;
		return modelAdapter;
	}

	private _getCurrentModelAdapter(): ChatEditorModel | null {
		const adapter = this._modelAdapter.value;
		return this.model && adapter && !adapter.isDisposed() ? adapter : null;
	}

	private _setModelReference(reference: IChatModelReference | undefined, expectedGeneration?: number): boolean {
		if (this.isDisposed() || (expectedGeneration !== undefined && expectedGeneration !== this._modelReferenceGeneration)) {
			reference?.dispose();
			return false;
		}
		this.modelRef.value = reference;
		return true;
	}

	private shouldReplaceEmptyLocalSession(sessionResource: URI): boolean {
		return LocalChatSessionUri.isLocalSession(sessionResource)
			&& !!this.model
			&& !this.model.hasRequests
			&& getDefaultNewChatSessionType(this.configurationService, this.chatSessionsService) !== localChatSessionType;
	}

	/**
	 * Updates the editor input to track a new model. Called when the widget swaps
	 * from an untitled session to a real session.
	 */
	updateModel(model: IChatModel): void {
		this.markModelReferenceActive();
		this._modelReferenceGeneration++;
		this._modelAdapter.clear();
		this._sessionResource = model.sessionResource;
		this.cachedName = model.hasCustomTitle ? model.title : truncate(model.title, ChatEditorTitleMaxLength);
		this._setModelReference(this.chatService.acquireExistingSession(model.sessionResource, 'ChatEditorInput#updateModel'));
		this._modelWasReleased = !this.model;
		if (this.model) {
			this._modelAdapter.value = new ChatEditorModel(this.model);
		}
		this._trackModelChanges();
		this.cachedIcon = undefined;
		this._onDidChangeLabel.fire();
	}

	private _trackModelChanges(): void {
		if (!this.model) {
			return;
		}
		this._modelChangeListener.value = this.model.onDidChange(() => {
			if (this.model?.title) {
				this.cachedName = this.model.hasCustomTitle ? this.model.title : truncate(this.model.title, ChatEditorTitleMaxLength);
			}
			this.cachedIcon = undefined;
			this._onDidChangeLabel.fire();
		});
	}

	private iconsEqual(a: ThemeIcon | URI, b: ThemeIcon | URI): boolean {
		if (ThemeIcon.isThemeIcon(a) && ThemeIcon.isThemeIcon(b)) {
			return a.id === b.id;
		}
		if (a instanceof URI && b instanceof URI) {
			return a.toString() === b.toString();
		}
		return false;
	}

}

export class ChatEditorModel extends Disposable {
	private _isResolved = false;

	constructor(
		readonly model: IChatModel
	) { super(); }

	async resolve(): Promise<void> {
		this._isResolved = true;
	}

	isResolved(): boolean {
		return this._isResolved;
	}

	isDisposed(): boolean {
		return this._store.isDisposed;
	}
}


namespace ChatEditorUri {

	const scheme = Schemas.vscodeChatEditor;

	export function getNewEditorUri(): URI {
		const handle = Math.floor(Math.random() * 1e9);
		return URI.from({ scheme, path: `chat-${handle}` });
	}

	export function parse(resource: URI): number | undefined {
		if (resource.scheme !== scheme) {
			return undefined;
		}

		const match = resource.path.match(/chat-(\d+)/);
		const handleStr = match?.[1];
		if (typeof handleStr !== 'string') {
			return undefined;
		}

		const handle = parseInt(handleStr);
		if (isNaN(handle)) {
			return undefined;
		}

		return handle;
	}
}

interface ISerializedChatEditorInput {
	readonly options: IChatEditorOptions;
	readonly resource: URI;
	readonly sessionResource: URI | undefined;
}

export class ChatEditorInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): input is ChatEditorInput {
		return input instanceof ChatEditorInput && !!input.sessionResource;
	}

	serialize(input: EditorInput): string | undefined {
		if (!this.canSerialize(input)) {
			return undefined;
		}

		const obj: ISerializedChatEditorInput = {
			options: input.options,
			sessionResource: input.sessionResource,
			resource: input.resource,

		};
		return JSON.stringify(obj);
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			// Old inputs have a session id for local session
			// Use revive to properly restore URIs and other special objects in options.target.data
			const parsed = revive(JSON.parse(serializedEditor));

			// First if we have a modern session resource, use that
			if (parsed.sessionResource) {
				const sessionResource = URI.revive(parsed.sessionResource);
				return instantiationService.createInstance(ChatEditorInput, sessionResource, parsed.options);
			}

			// Otherwise check to see if we're a chat editor with a local session id
			let resource = URI.revive(parsed.resource);
			if (resource.scheme === Schemas.vscodeChatEditor && parsed.sessionId) {
				resource = LocalChatSessionUri.forSession(parsed.sessionId);
			}

			return instantiationService.createInstance(ChatEditorInput, resource, parsed.options);
		} catch (err) {
			return undefined;
		}
	}
}

export async function showClearEditingSessionConfirmation(model: IChatModel, dialogService: IDialogService, options?: IClearEditingSessionConfirmationOptions): Promise<boolean> {
	const undecidedEdits = shouldShowClearEditingSessionConfirmation(model, options);
	if (!undecidedEdits) {
		return true; // safe to dispose without confirmation
	}

	const defaultPhrase = nls.localize('chat.startEditing.confirmation.pending.message.default1', "Starting a new chat will end your current edit session.");
	const defaultTitle = nls.localize('chat.startEditing.confirmation.title', "Start new chat?");
	const phrase = options?.messageOverride ?? defaultPhrase;
	const title = options?.titleOverride ?? defaultTitle;

	const { result } = await dialogService.prompt({
		title,
		message: phrase + ' ' + nls.localize('chat.startEditing.confirmation.pending.message.2', "Do you want to keep pending edits to {0} files?", undecidedEdits),
		type: 'info',
		cancelButton: true,
		buttons: [
			{
				label: nls.localize('chat.startEditing.confirmation.acceptEdits', "Keep & Continue"),
				run: async () => {
					await model.editingSession!.accept();
					return true;
				}
			},
			{
				label: nls.localize('chat.startEditing.confirmation.discardEdits', "Undo & Continue"),
				run: async () => {
					await model.editingSession!.reject();
					return true;
				}
			}
		],
	});

	return Boolean(result);
}

/** Returns the number of files in the  model's modifications that need a prompt before saving */
export function shouldShowClearEditingSessionConfirmation(model: IChatModel, options?: IClearEditingSessionConfirmationOptions): number {
	if (!model.editingSession || (model.willKeepAlive && !options?.isArchiveAction)) {
		return 0; // safe to dispose without confirmation
	}

	const currentEdits = model.editingSession.entries.get();
	const undecidedEdits = currentEdits.filter((edit) => edit.state.get() === ModifiedFileEntryState.Modified);
	return undecidedEdits.length;
}

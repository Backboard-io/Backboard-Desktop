/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/canvasOverlay.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { autorun } from '../../../../base/common/observable.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { isDefined } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getWorkbenchContribution, IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatModel } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { RightWorkbenchCommandId } from './rightWorkbench.js';
import { CanvasMediaKind, CanvasView, extractCanvasImageGroups, extractCanvasTurns, ICanvasComment, ICanvasFilter, ICanvasImage, ICanvasImageGroup, ICanvasMediaModel, ICanvasModelChoices, ICanvasSendOptions, hasPerReferenceInstructions, referenceName, RightWorkbenchCanvas } from './rightWorkbenchCanvas.js';

/** How many recently updated chats Canvas reads for their media (it shows every chat's). */
const OTHER_CHATS_LIMIT = 200;
/** How many other chats are read at once. */
const OTHER_CHATS_CONCURRENCY = 4;
/** Longest edge of the previews tiles, filmstrips, and the thread show. */
const THUMBNAIL_EDGE = 640;
/** The composer value that turns image or video generation off (not a model to list). */
const GENERATIVE_MEDIA_OFF = 'off';
const SIDE_WIDTH_STORAGE_KEY = 'sessions.canvas.chatWidth';
const FILTER_STORAGE_KEY = 'sessions.canvas.filter';
/** Uploads live in `~/.backboard/canvas-uploads`, shared by every chat. */
const UPLOADS_FOLDER = 'canvas-uploads';
const UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'mov', 'webm', 'm4v'];

const MODEL_NAME_WORDS: Record<string, string> = { gpt: 'GPT', ai: 'AI', sd: 'SD', xl: 'XL', hd: 'HD', flux: 'FLUX', ltx: 'LTX', mini: 'mini' };

/**
 * A model's display name: a catalog label that is already a name stays,
 * an id like `google/gemini-3.1-flash-image` becomes `Gemini 3.1 Flash Image`.
 */
function modelDisplayName(label: string): string {
	if (/[A-Z\s]/.test(label)) {
		return label;
	}
	const name = label.slice(label.lastIndexOf('/') + 1);
	return name.split(/[-_]/).filter(Boolean).map(word => MODEL_NAME_WORDS[word] ?? (/^\d/.test(word) ? word : word[0].toUpperCase() + word.slice(1))).join(' ');
}


/** Blob types to play videos as. QuickTime `.mov` is typed as MP4: Chromium plays H.264 `.mov` that way, but not as `video/quicktime`. */
const VIDEO_MIME_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm' };

/**
 * Canvas as its own surface, like Codex's image playground: every image and
 * video from all chats on one timeline, each turn labelled with its chat. It
 * covers the Sessions window beside the sidebar (which stays usable), opens
 * from the sidebar's Canvas row or an image in a chat, and closes with Escape,
 * the Canvas row, or by picking a chat. Edits and comments go to the active chat.
 */
export class SessionsCanvasOverlay extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsCanvasOverlay';

	private readonly openStore = this._register(new DisposableStore());
	private canvas: RightWorkbenchCanvas | undefined;
	/** Each chat's media as last read, reused while the chat is unchanged (by its last update). */
	private readonly chatMediaCache = new Map<string, { readonly updated: number; readonly groups: readonly ICanvasImageGroup[] }>();
	/** Display names of image/video models by id, learnt from the catalogs. */
	private readonly modelLabels = new Map<string, string>();
	/** The last model list read per kind, so the menu opens at once. */
	private readonly modelChoices = new Map<CanvasMediaKind, ICanvasModelChoices>();
	/** Image previews by item, kept across openings; revoked with the contribution. */
	private readonly thumbnailUrls = new Map<string, Promise<string | undefined>>();
	/** Composer attachment ids Canvas added, replaced as its selection changes. */
	private canvasAttachmentIds: string[] = [];

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IFileService private readonly fileService: IFileService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const url of this.thumbnailUrls.values()) {
				void url.then(resolved => resolved?.startsWith('blob:') && URL.revokeObjectURL(resolved));
			}
		}));
	}

	get isOpen(): boolean {
		return !!this.canvas;
	}

	/** Opens Canvas over the window, selecting `imageUrl` in the given view. */
	open(imageUrl: string | undefined, view: CanvasView | undefined): void {
		if (this.canvas) {
			this.canvas.reveal(imageUrl, view);
			return;
		}
		const store = this.openStore;
		const overlay = append(this.layoutService.mainContainer, $('.sessions-canvas-overlay'));
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.ariaLabel = localize('sessionsCanvas.label', "Canvas");
		overlay.tabIndex = -1;
		store.add(toDisposable(() => overlay.remove()));
		this.trackSidebar(overlay, store);

		store.add(addDisposableListener(overlay, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				event.preventDefault();
				this.close();
			}
		}));

		const body = append(overlay, $('.sessions-canvas-overlay-body'));
		let chatResource: URI | undefined;
		let listUploads: (saved: readonly URI[]) => Promise<ICanvasImage[]> = async () => [];
		const blobUrls: string[] = [];
		store.add(toDisposable(() => blobUrls.forEach(url => URL.revokeObjectURL(url))));
		const canvas = store.add(this.instantiationService.createInstance(RightWorkbenchCanvas, body, {
			toDisplayUrl: (image, size) => size === 'thumb' ? this.thumbnailUrl(image, blobUrls) : this.fullUrl(image, blobUrls),
			// Canvas has its own composer: selecting items must not leave attachments in the
			// chat's composer. Sends and comments attach their images themselves.
			setComposerImages: () => { },
			sendComments: comments => {
				if (chatResource) {
					void this.sendComments(chatResource, comments);
				}
			},
			sendEdit: (images, prompt, kind, seconds, options) => {
				void withChat(options).then(resource => resource ? this.sendEdit(resource, images, prompt, kind, seconds) : this.warnNotSent());
			},
			getMediaModel: kind => chatResource ? this.getMediaModel(chatResource, kind) : undefined,
			getModelChoices: async kind => chatResource ? this.getModelChoices(chatResource, kind) : undefined,
			getChatModels: () => {
				const input = chatResource && this.chatWidgetService.getWidgetBySessionResource(chatResource)?.input;
				return input && {
					models: input.getSelectableLanguageModels().map(model => ({ id: model.identifier, label: model.metadata.name })),
					current: input.currentLanguageModel,
				};
			},
			setChatModel: id => {
				if (chatResource) {
					this.chatWidgetService.getWidgetBySessionResource(chatResource)?.input.switchModelByIdentifier(id);
				}
			},
			setModel: (kind, value) => {
				if (chatResource) {
					this.mediaOption(chatResource, kind)?.setValue(value);
				}
			},
			uploadFiles: async files => listUploads(await this.storeUploads(files.map(file => ({
				name: file.name,
				save: async (target: URI) => this.fileService.writeFile(target, VSBuffer.wrap(new Uint8Array(await file.arrayBuffer()))),
			})))),
			pickUploads: async () => {
				const picked = await this.fileDialogService.showOpenDialog({
					title: localize('sessionsCanvas.uploadTitle', "Upload Images or Videos"),
					canSelectFiles: true,
					canSelectMany: true,
					filters: [{ name: localize('sessionsCanvas.uploadFilter', "Images and Videos"), extensions: UPLOAD_EXTENSIONS }],
				});
				return picked?.length ? listUploads(await this.storeUploads(picked.map(uri => ({ name: basename(uri), save: (target: URI) => this.fileService.copy(uri, target) })))) : [];
			},
			filter: this.storageService.getObject<ICanvasFilter>(FILTER_STORAGE_KEY, StorageScope.PROFILE),
			saveFilter: filter => this.storageService.store(FILTER_STORAGE_KEY, JSON.stringify(filter), StorageScope.PROFILE, StorageTarget.USER),
			sideWidth: this.storageService.getNumber(SIDE_WIDTH_STORAGE_KEY, StorageScope.PROFILE),
			saveSideWidth: width => this.storageService.store(SIDE_WIDTH_STORAGE_KEY, width, StorageScope.PROFILE, StorageTarget.USER),
			saveAs: image => void this.saveAs(image),
			revealInOS: image => {
				if (image.localFile) {
					void this.commandService.executeCommand('revealFileInOS', image.localFile);
				}
			},
			sendMessage: (prompt, options) => {
				void withChat(options).then(resource => resource ? this.sendMessage(resource, prompt) : this.warnNotSent());
			},
			focusSourceChat: source => {
				if (source.key !== chatResource?.toString()) {
					adoptedChat = source.key;
					void this.openChat(source.key).then(() => canvas.focus());
				}
			},
			openLink: href => void this.openerService.open(href),
		}));
		this.canvas = canvas;
		store.add(toDisposable(() => this.canvas = undefined));

		// Every chat's media on one timeline: the active chat's streams in live,
		// the others load once in the background.
		// A chat Canvas itself switched to (to show an item's own chat), which must not close it.
		let adoptedChat: string | undefined;
		// Set while Canvas starts a new chat for an upload: whatever chat becomes active next is that one.
		let adoptNextChat = false;
		// The draft chat Canvas started: when it is saved under its real resource, Canvas follows that too.
		let adoptedDraft: string | undefined;
		/**
		 * The chat to send to: the current one, or for an upload a new chat in
		 * the same session (a new draft session never got a chat to send into).
		 */
		const withChat = async (options: ICanvasSendOptions | undefined): Promise<URI | undefined> => {
			const session = this.sessionsService.activeSession.get();
			if (!options?.newChat || !session) {
				return chatResource;
			}
			const previous = chatResource?.toString();
			adoptNextChat = true;
			await this.sessionsService.openNewChatInSession(session);
			// Wait for the new chat's widget, which sends the message.
			for (let waited = 0; waited < 5000; waited += 100) {
				if (chatResource && chatResource.toString() !== previous && this.chatWidgetService.getWidgetBySessionResource(chatResource)) {
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			adoptNextChat = false;
			canvas.focus();
			return chatResource;
		};
		let pendingReveal: { readonly imageUrl: string | undefined; readonly view: CanvasView | undefined } | undefined = { imageUrl, view };
		const modelStore = store.add(new DisposableStore());
		const responseListeners = store.add(new DisposableMap<object>());
		const mediaModelListener = store.add(new MutableDisposable());
		const chatModelListener = store.add(new MutableDisposable());
		let otherGroups: ICanvasImageGroup[] = [];
		let currentGroups: ICanvasImageGroup[] = [];
		let uploadGroups: ICanvasImageGroup[] = [];
		// Until the chat Canvas follows has loaded, its media stays as read with the other chats (so a switch never drops the shown item).
		let currentLoaded = false;
		const publish = () => {
			const currentKey = chatResource?.toString();
			const all = [...otherGroups.filter(group => !currentLoaded || group.source?.key !== currentKey), ...currentGroups, ...uploadGroups]
				.sort((a, b) => a.timestamp - b.timestamp);
			canvas.setGroups(all, 'all');
			if (pendingReveal) {
				canvas.reveal(pendingReveal.imageUrl, pendingReveal.view);
				pendingReveal = undefined;
			}
		};
		// Uploads show with everything else; after saving, the new ones are listed and handed back.
		listUploads = async saved => {
			uploadGroups = await this.readUploads();
			publish();
			const keys = new Set(saved.map(uri => uri.toString()));
			return uploadGroups.flatMap(group => group.images).filter(image => keys.has(image.key));
		};
		void this.readUploads().then(groups => {
			uploadGroups = groups;
			publish();
		});
		let refresh = () => { };
		const refreshScheduler = store.add(new RunOnceScheduler(() => refresh(), 150));
		let openedOn: string | undefined | null = null;
		store.add(autorun(reader => {
			const session = this.sessionsService.activeSession.read(reader);
			const chat = session?.activeChat.read(reader);
			chat?.lastTurnEnd.read(reader);
			const chatTitle = chat?.title.read(reader) || session?.title.read(reader) || '';
			const workingDirectory = session?.workspace.read(reader)?.folders[0]?.workingDirectory;
			// Picking another chat in the sidebar leaves Canvas for that chat.
			const key = chat?.resource.toString();
			if (openedOn === null || (key !== undefined && (key === adoptedChat || adoptNextChat || (adoptedDraft !== undefined && openedOn === adoptedDraft)))) {
				// A draft Canvas started is followed once more, to its saved chat.
				adoptedDraft = adoptNextChat ? key : undefined;
				openedOn = key;
			} else if (key !== openedOn) {
				queueMicrotask(() => this.close());
				return;
			}
			// The chat Canvas leaves keeps its media on the timeline with the others.
			if (chatResource && chatResource.toString() !== key) {
				const leaving = chatResource.toString();
				otherGroups = [...otherGroups.filter(group => group.source?.key !== leaving), ...currentGroups];
				currentGroups = [];
			}
			modelStore.clear();
			responseListeners.clearAndDisposeAll();
			chatResource = chat?.resource;
			const modelListener = modelStore.add(new MutableDisposable());
			currentLoaded = false;
			const follow = (model: IChatModel | undefined) => {
				currentLoaded = !!model;
				refresh = () => {
					const requests = model?.getRequests() ?? [];
					for (const request of requests) {
						const response = request.response;
						if (response && !responseListeners.has(response)) {
							responseListeners.set(response, response.onDidChange(() => refreshScheduler.schedule()));
						}
					}
					const source = chat ? { key: chat.resource.toString(), title: chatTitle } : undefined;
					currentGroups = extractCanvasImageGroups(requests, workingDirectory).map(group => ({ ...group, source }));
					publish();
					canvas.setThread(chat ? { title: chatTitle, turns: extractCanvasTurns(requests, workingDirectory) } : undefined);
					canvas.refreshMediaModels();
				};
				modelListener.value = model?.onDidChange(() => refreshScheduler.schedule());
				refresh();
			};
			follow((chat && this.chatService.getSession(chat.resource)) ?? (session && this.chatService.getSession(session.resource)));
			// A chat Canvas switched to may not be loaded yet; hold it loaded while it is shown.
			if (chat) {
				const loading = new CancellationTokenSource();
				modelStore.add(toDisposable(() => loading.dispose(true)));
				void this.chatService.acquireOrLoadSession(chat.resource, ChatAgentLocation.Chat, loading.token, 'sessionsCanvas').then(reference => {
					if (!reference) {
						return;
					}
					if (loading.token.isCancellationRequested) {
						reference.dispose();
						return;
					}
					modelStore.add(reference);
					follow(reference.object);
				}, () => { /* the thread stays as the loaded model showed it */ });
			}

			// Keep the composer's model chip in step with the chat's pickers, named from the catalogs.
			const widget = chatResource && this.chatWidgetService.getWidgetBySessionResource(chatResource);
			mediaModelListener.value = widget ? widget.input.onDidChangeBackboardGenericConfigOptions(() => canvas.refreshMediaModels()) : undefined;
			// The thread header shows the chat's language model, also when it is changed in the chat itself.
			chatModelListener.value = widget ? autorun(modelReader => {
				widget.input.selectedLanguageModel.read(modelReader);
				canvas.refreshMediaModels();
			}) : undefined;
			canvas.refreshMediaModels();
			if (chatResource) {
				const resource = chatResource;
				void Promise.all((['image', 'video'] as const).map(kind => this.getModelChoices(resource, kind).catch(() => undefined))).then(() => canvas.refreshMediaModels());
			}
		}));
		const otherChats = new CancellationTokenSource();
		store.add(toDisposable(() => otherChats.dispose(true)));
		// Each chat's media shows as soon as that chat has loaded, newest chats first.
		const publishScheduler = store.add(new RunOnceScheduler(() => publish(), 100));
		void this.loadOtherChatGroups(chatResource?.toString(), otherChats.token, groups => {
			otherGroups = [...otherGroups, ...groups];
			publishScheduler.schedule();
		});

		const previousFocus = getWindow(overlay).document.activeElement as HTMLElement | null;
		store.add(toDisposable(() => previousFocus?.focus()));
		overlay.focus();
	}

	close(): void {
		this.openStore.clear();
	}

	/** Keeps the overlay's left edge on the sidebar's right edge, so the sidebar stays usable. */
	private trackSidebar(overlay: HTMLElement, store: DisposableStore): void {
		const container = this.layoutService.mainContainer;
		const update = () => {
			const sidebar = this.layoutService.isVisible(Parts.SIDEBAR_PART) ? this.layoutService.getContainer(mainWindow, Parts.SIDEBAR_PART) : undefined;
			const rect = sidebar?.getBoundingClientRect();
			const left = rect && rect.width > 0 ? Math.max(0, rect.right - container.getBoundingClientRect().left) : 0;
			overlay.style.left = `${left}px`;
			overlay.classList.toggle('beside-sidebar', left > 0);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(container);
		const sidebar = this.layoutService.getContainer(mainWindow, Parts.SIDEBAR_PART);
		if (sidebar) {
			observer.observe(sidebar);
		}
		store.add(toDisposable(() => observer.disconnect()));
		store.add(this.layoutService.onDidChangePartVisibility(() => update()));
	}

	/**
	 * Media from the most recently updated other chats, newest chat first,
	 * each group labelled with its chat. Chat models are loaded only long
	 * enough to read their responses.
	 */
	private async loadOtherChatGroups(currentChat: string | undefined, token: CancellationTokenSource['token'], onChat: (groups: ICanvasImageGroup[]) => void): Promise<void> {
		const queue = this.sessionsManagementService.getSessions()
			.filter(session => !session.isArchived.get())
			.flatMap(session => session.chats.get().map(chat => ({ session, chat })))
			.filter(({ chat }) => chat.resource.toString() !== currentChat && !chat.isArchived.get())
			.sort((a, b) => b.chat.updatedAt.get().getTime() - a.chat.updatedAt.get().getTime())
			.slice(0, OTHER_CHATS_LIMIT);
		const readNext = async (): Promise<void> => {
			for (let next = queue.shift(); next && !token.isCancellationRequested; next = queue.shift()) {
				const { session, chat } = next;
				const key = chat.resource.toString();
				const updated = chat.updatedAt.get().getTime();
				let groups = this.chatMediaCache.get(key);
				// A chat unchanged since Canvas last read it reuses that read.
				if (groups?.updated !== updated) {
					try {
						const reference = await this.chatService.acquireOrLoadSession(chat.resource, ChatAgentLocation.Chat, token, 'sessionsCanvas');
						if (!reference) {
							continue;
						}
						try {
							const workingDirectory = session.workspace.get()?.folders[0]?.workingDirectory;
							groups = { updated, groups: extractCanvasImageGroups(reference.object.getRequests(), workingDirectory) };
							this.chatMediaCache.set(key, groups);
						} finally {
							reference.dispose();
						}
					} catch {
						continue; // A chat that cannot be restored simply contributes nothing.
					}
				}
				if (groups.groups.length) {
					const source = { key, title: chat.title.get() || session.title.get() };
					onChat(groups.groups.map(group => ({ ...group, source })));
				}
			}
		};
		await Promise.all(Array.from({ length: OTHER_CHATS_CONCURRENCY }, readNext));
	}

	/**
	 * The stage's copy of an item: an image's saved file (quicker than the
	 * hosted original), a hosted video (streamed), or a saved video as a blob.
	 */
	private async fullUrl(image: ICanvasImage, blobUrls: string[]): Promise<string | undefined> {
		const file = image.kind === 'image' ? image.localFile ?? (image.src.scheme === Schemas.file ? image.src : undefined) : image.src.scheme === Schemas.file ? image.src : undefined;
		if (!file) {
			return image.key;
		}
		try {
			const content = await this.fileService.readFile(file);
			// Videos need their type for the element to play a blob.
			const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
			const type = image.kind === 'video' ? VIDEO_MIME_TYPES[extension] ?? 'video/mp4' : undefined;
			const url = URL.createObjectURL(new Blob([content.value.buffer.slice()], type ? { type } : undefined));
			blobUrls.push(url);
			return url;
		} catch {
			return image.src.scheme === Schemas.file ? undefined : image.key;
		}
	}

	/**
	 * A small preview of an image, made once from its saved file and kept
	 * across openings; hosted-only images and videos show their original.
	 */
	private thumbnailUrl(image: ICanvasImage, blobUrls: string[]): Promise<string | undefined> {
		if (image.kind === 'video') {
			return this.fullUrl(image, blobUrls);
		}
		let url = this.thumbnailUrls.get(image.key);
		if (!url) {
			url = this.makeThumbnail(image);
			this.thumbnailUrls.set(image.key, url);
		}
		return url;
	}

	private async makeThumbnail(image: ICanvasImage): Promise<string | undefined> {
		const file = image.localFile ?? (image.src.scheme === Schemas.file ? image.src : undefined);
		if (!file) {
			return image.key;
		}
		try {
			const content = await this.fileService.readFile(file);
			const bitmap = await createImageBitmap(new Blob([content.value.buffer.slice()]));
			const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height));
			const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
			canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			bitmap.close();
			return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 }));
		} catch {
			return image.src.scheme === Schemas.file ? undefined : image.key;
		}
	}


	/** The chat's model picker for this kind: the model list, or the older on/off image switch. */
	private mediaOption(chatResource: URI, kind: CanvasMediaKind) {
		const widget = this.chatWidgetService.getWidgetBySessionResource(chatResource) ?? this.chatWidgetService.lastFocusedWidget;
		const options = widget?.input.getBackboardGenericConfigOptions() ?? [];
		const ids = kind === 'video' ? ['videoModel'] : ['imageModel', 'imageGeneration'];
		return ids.map(id => options.find(option => option.id === id)).find(isDefined);
	}

	private getMediaModel(chatResource: URI, kind: CanvasMediaKind): ICanvasMediaModel | undefined {
		const option = this.mediaOption(chatResource, kind);
		if (!option) {
			return undefined;
		}
		if (!option.active) {
			return { active: false, label: undefined };
		}
		// Show the model's name rather than its id.
		const info = option.getEnumInfo();
		const current = info?.current ?? option.valueLabel;
		const index = current !== undefined && info ? info.values.indexOf(current) : -1;
		const label = (current && this.modelLabels.get(current)) ?? (index >= 0 ? info?.labels[index] : undefined) ?? current;
		return { active: true, label: label ? modelDisplayName(label) : option.label };
	}

	/**
	 * The models the composer's menu lists, one row per model name (the same
	 * model from two providers shows once, as the current pick when it is one),
	 * without the "off" choice. The last read catalog answers at once; the live
	 * catalog refreshes it for next time.
	 */
	private getModelChoices(chatResource: URI, kind: CanvasMediaKind): Promise<ICanvasModelChoices | undefined> {
		const option = this.mediaOption(chatResource, kind);
		if (!option) {
			return Promise.resolve(undefined);
		}
		const current = option.active ? option.getEnumInfo()?.current : undefined;
		const fresh = Promise.resolve(option.getDynamicEnumInfo?.() ?? option.getEnumInfo()).then(info => {
			if (!info) {
				return undefined;
			}
			const rows = new Map<string, string>();
			for (const [index, value] of info.values.entries()) {
				if (value === GENERATIVE_MEDIA_OFF || value === option.deactivationValue) {
					continue;
				}
				const label = modelDisplayName(info.labels[index] || value);
				this.modelLabels.set(value, label);
				if (!rows.has(label) || value === current) {
					rows.set(label, value);
				}
			}
			const models = { values: [...rows.values()], labels: [...rows.keys()], current: undefined };
			this.modelChoices.set(kind, models);
			return models;
		});
		const cached = this.modelChoices.get(kind);
		const withCurrent = (models: ICanvasModelChoices | undefined) => models && {
			...models,
			// The current pick shows under its own name even when another provider's copy is listed.
			current: current && (models.values.includes(current) ? current : models.values[models.labels.indexOf(this.modelLabels.get(current) ?? '')]),
		};
		if (cached) {
			fresh.catch(() => undefined);
			return Promise.resolve(withCurrent(cached));
		}
		return fresh.then(withCurrent);
	}


	/**
	 * The focused view's composer: attaches the shown item and asks the chat
	 * to edit it (or make a video from it). Canvas stays open and shows the
	 * result when it arrives. A hosted-only item is referenced by URL.
	 */
	private async sendEdit(chatResource: URI, images: readonly ICanvasImage[], prompt: string, kind: CanvasMediaKind, seconds: number | undefined): Promise<void> {
		const widget = this.chatWidgetService.getWidgetBySessionResource(chatResource) ?? this.chatWidgetService.lastFocusedWidget;
		if (!widget || !images.length) {
			this.warnNotSent();
			return;
		}
		const option = this.mediaOption(chatResource, kind);
		if (option && !option.active && option.activationValue) {
			// Turn on the generator the user picked in Canvas, with the chat's default model.
			option.setValue(option.activationValue);
		}
		await this.setComposerImages(chatResource, images);
		// Generated items share labels ("Generated image"), so each is named by its file (or URL) too.
		const subject = (image: ICanvasImage) => image.localFile ? `${image.label} (${basename(image.localFile)})` : `${image.label} (${image.key})`;
		let message: string;
		if (images.length === 1) {
			const [image] = images;
			const named = `${subject(image)}, @${referenceName(0)}`;
			message = kind === 'video'
				? image.kind === 'video'
					// Worded as a new video guided by the clip: edit wording puts Seedance in an editing mode OpenRouter cannot run.
					? localize('sessionsCanvas.editVideo', "Make a new video that uses the attached video \"{0}\" as its reference, following its camera motion, framing, movement and scene: {1}", named, prompt)
					: localize('sessionsCanvas.videoFromImage', "Make a video from the attached image \"{0}\": {1}", named, prompt)
				: image.kind === 'video'
					? localize('sessionsCanvas.imageFromVideo', "Make an image based on the attached video \"{0}\": {1}", named, prompt)
					: localize('sessionsCanvas.editImage', "Edit the attached image \"{0}\": {1}", named, prompt);
		} else {
			// The prompt points at images as @image_1, @image_2, …: spell out which attachment each one is.
			const legend = images.map((image, index) => `@${referenceName(index)}: ${subject(image)}`).join('\n');
			// Separate instructions per image ask for separate outputs, not one combining them.
			message = hasPerReferenceInstructions(prompt)
				? kind === 'video'
					? localize('sessionsCanvas.videoPerImage', "Make a separate video for each image below, following the instruction given for that image. The attached images are referred to as:\n{0}\n\n{1}", legend, prompt)
					: localize('sessionsCanvas.editPerImage', "Edit each image below separately, following the instruction given for that image. The attached images are referred to as:\n{0}\n\n{1}", legend, prompt)
				: kind === 'video'
					? localize('sessionsCanvas.videoFromImages', "Make a video from the attached images. They are referred to as:\n{0}\n\n{1}", legend, prompt)
					: localize('sessionsCanvas.editImages', "Edit the attached images. They are referred to as:\n{0}\n\n{1}", legend, prompt);
		}
		// A picked length answers the agent's "Video length" question up front; Auto tells it to choose rather than ask.
		const lengthNote = kind !== 'video' ? undefined : seconds
			? localize('sessionsCanvas.videoLength', "{0}, {1} seconds", message, seconds)
			: localize('sessionsCanvas.videoLengthAuto', "{0}\n\nChoose a suitable video length yourself; don't ask me.", message);
		await widget.acceptInput(lengthNote ?? message);
		this.canvasAttachmentIds = [];
	}


	private async uploadsFolder(): Promise<URI> {
		return joinPath(await this.pathService.userHome(), '.backboard', UPLOADS_FOLDER);
	}

	/**
	 * Saves uploads into Canvas's folder as `<batch time>-<name>`, so one
	 * upload's files list together under its time. Returns what was saved.
	 */
	private async storeUploads(entries: readonly { readonly name: string; readonly save: (target: URI) => Promise<unknown> }[]): Promise<URI[]> {
		const folder = await this.uploadsFolder();
		const batch = Date.now();
		const used = new Set<string>();
		const saved: URI[] = [];
		for (const [index, entry] of entries.entries()) {
			let name = entry.name.replace(/[\\/:*?"<>|]/g, '_') || `upload-${index + 1}`;
			if (used.has(name)) {
				name = `${index + 1}-${name}`;
			}
			used.add(name);
			const target = joinPath(folder, `${batch}-${name}`);
			try {
				await entry.save(target);
				saved.push(target);
			} catch (error) {
				this.notificationService.error(localize('sessionsCanvas.uploadFailed', "Could not upload {0}: {1}", entry.name, error instanceof Error ? error.message : String(error)));
			}
		}
		return saved;
	}

	/** Every upload as Canvas items, one group per upload (the time prefix on its files). */
	private async readUploads(): Promise<ICanvasImageGroup[]> {
		let children;
		try {
			children = (await this.fileService.resolve(await this.uploadsFolder())).children ?? [];
		} catch {
			return []; // Nothing uploaded yet.
		}
		const batches = new Map<number, ICanvasImage[]>();
		for (const child of children) {
			const match = /^(?<time>\d{13})-(?<name>.+)$/.exec(child.name);
			const extension = child.name.split('.').pop()?.toLowerCase() ?? '';
			const kind: CanvasMediaKind | undefined = VIDEO_MIME_TYPES[extension] ? 'video' : UPLOAD_EXTENSIONS.includes(extension) ? 'image' : undefined;
			if (child.isDirectory || !match?.groups || !kind) {
				continue;
			}
			const time = Number(match.groups.time);
			const images = batches.get(time) ?? [];
			images.push({ key: child.resource.toString(), src: child.resource, label: match.groups.name, kind, localFile: child.resource, uploaded: true });
			batches.set(time, images);
		}
		const source = { key: UPLOADS_FOLDER, title: localize('sessionsCanvas.uploaded', "Uploaded") };
		return [...batches].map(([timestamp, images]) => ({ timestamp, images, source }));
	}

	/** Saves a copy of the item: the session's saved file, or the hosted original. */
	private async saveAs(image: ICanvasImage): Promise<void> {
		const name = basename(image.localFile ?? image.src) || (image.kind === 'video' ? 'video.mp4' : 'image.png');
		const target = await this.fileDialogService.showSaveDialog({
			title: image.kind === 'video' ? localize('sessionsCanvas.saveVideo', "Download Video") : localize('sessionsCanvas.saveImage', "Download Image"),
			defaultUri: joinPath(await this.fileDialogService.defaultFilePath(), name),
		});
		if (!target) {
			return;
		}
		try {
			if (image.localFile) {
				await this.fileService.copy(image.localFile, target, true);
			} else {
				const response = await fetch(image.key);
				await this.fileService.writeFile(target, VSBuffer.wrap(new Uint8Array(await response.arrayBuffer())));
			}
		} catch (error) {
			this.notificationService.error(localize('sessionsCanvas.saveFailed', "Could not download {0}: {1}", image.label, error instanceof Error ? error.message : String(error)));
		}
	}

	/** A Canvas message that found no chat to go to must not vanish silently. */
	private warnNotSent(): void {
		this.notificationService.warn(localize('sessionsCanvas.notSent', "Canvas couldn't send your message because no chat was ready. Open a chat and try again."));
	}

	/** The composer's plain message: sent to the chat without the images Canvas attached. */
	private async sendMessage(chatResource: URI, prompt: string): Promise<void> {
		const widget = this.chatWidgetService.getWidgetBySessionResource(chatResource) ?? this.chatWidgetService.lastFocusedWidget;
		if (!widget) {
			this.warnNotSent();
			return;
		}
		await this.setComposerImages(chatResource, []);
		await widget.acceptInput(prompt);
	}

	/** Makes the chat with this resource the active one, under Canvas. */
	private async openChat(chatKey: string): Promise<void> {
		for (const session of this.sessionsManagementService.getSessions()) {
			const chat = session.chats.get().find(candidate => candidate.resource.toString() === chatKey);
			if (chat) {
				await this.sessionsService.openChat(session, chat.resource);
				return;
			}
		}
	}

	/**
	 * Replaces the images Canvas previously attached to the chat's composer
	 * with the current selection, leaving the user's own attachments alone.
	 */
	private async setComposerImages(chatResource: URI, images: readonly ICanvasImage[]): Promise<void> {
		const widget = this.chatWidgetService.getWidgetBySessionResource(chatResource) ?? this.chatWidgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}
		const previous = this.canvasAttachmentIds.filter(id => widget.attachmentModel.attachments.some(entry => entry.id === id));
		if (previous.length) {
			widget.attachmentModel.delete(...previous);
		}
		const files = images.map(image => image.localFile).filter(isDefined);
		this.canvasAttachmentIds = files.map(file => file.toString());
		for (const file of files) {
			await widget.attachmentModel.addFile(file);
		}
	}

	/**
	 * Codex's comment "Send": one message that attaches every commented image
	 * and spells out each numbered note with where it was pinned.
	 */
	private async sendComments(chatResource: URI, comments: ReadonlyMap<ICanvasImage, readonly ICanvasComment[]>): Promise<void> {
		const widget = this.chatWidgetService.getWidgetBySessionResource(chatResource) ?? this.chatWidgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}
		await this.setComposerImages(chatResource, [...comments.keys()]);
		const lines: string[] = [localize('sessionsCanvas.batchEditIntro', "Edit these images based on my comments:")];
		let number = 0;
		for (const [image, notes] of comments) {
			lines.push('', image.label);
			for (const note of notes) {
				number++;
				lines.push(localize('sessionsCanvas.batchEditNote', "{0}. At {1}% across, {2}% down: {3}", number, Math.round(note.x * 100), Math.round(note.y * 100), note.text));
			}
		}
		// Canvas stays open: its asset view shows the commented item and the chat working on it.
		await widget.acceptInput(lines.join('\n'));
		this.canvasAttachmentIds = [];
	}
}

registerWorkbenchContribution2(SessionsCanvasOverlay.ID, SessionsCanvasOverlay, WorkbenchPhase.AfterRestored);

/** Closes Canvas if it is open (e.g. when another full-window page opens from the sidebar). */
export const CLOSE_CANVAS_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.closeCanvas';
CommandsRegistry.registerCommand(CLOSE_CANVAS_COMMAND_ID, () => getWorkbenchContribution<SessionsCanvasOverlay>(SessionsCanvasOverlay.ID).close());

/** Whether Canvas is open. */
export const IS_CANVAS_OPEN_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.isCanvasOpen';
CommandsRegistry.registerCommand(IS_CANVAS_OPEN_COMMAND_ID, () => getWorkbenchContribution<SessionsCanvasOverlay>(SessionsCanvasOverlay.ID).isOpen);

registerAction2(class OpenSessionsCanvasAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenCanvas,
			title: localize2('sessionsCanvas.open', "Open Canvas"),
			icon: Codicon.fileMedia,
		});
	}

	override run(_accessor: ServicesAccessor, options?: { imageUrl?: string; view?: CanvasView }): void {
		const canvas = getWorkbenchContribution<SessionsCanvasOverlay>(SessionsCanvasOverlay.ID);
		// Without an image to show (the sidebar's Canvas row), the command toggles Canvas.
		if (!options && canvas.isOpen) {
			canvas.close();
		} else {
			canvas.open(options?.imageUrl, options?.view);
		}
	}
});

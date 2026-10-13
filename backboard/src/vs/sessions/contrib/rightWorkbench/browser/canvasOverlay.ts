/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/canvasOverlay.css';
import { $, addDisposableListener, append, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DeferredPromise, RunOnceScheduler } from '../../../../base/common/async.js';
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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getWorkbenchContribution, IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatModel } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IChat, ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { CANVAS_HOSTED_MEDIA_TIME_COMMAND_ID, RightWorkbenchCommandId } from './rightWorkbench.js';
import { CanvasMediaKind, CanvasView, extractCanvasImageGroups, extractCanvasTurns, ICanvasComment, ICanvasEditRequest, ICanvasFilter, ICanvasImage, ICanvasImageGroup, ICanvasMediaModel, ICanvasModelChoices, ICanvasSendOptions, hasPerReferenceInstructions, referenceName, RightWorkbenchCanvas } from './rightWorkbenchCanvas.js';
import { CANVAS_EDIT_MODELS, CANVAS_EDITS_FOLDER, CanvasEditError, ICanvasEditRecord, runCanvasEdit } from './canvasEdits.js';

/** How many recently updated chats Canvas reads for their media. */
const OTHER_CHATS_LIMIT = 200;
/** How many other chats are read at once (each is restored by the agent host, which the shown chat waits on too). */
const OTHER_CHATS_CONCURRENCY = 2;
/** Longest edge of the previews that tiles, filmstrips, and the thread show. */
const THUMBNAIL_EDGE = 640;
/** The composer value that turns image or video generation off (not a model to list). */
const GENERATIVE_MEDIA_OFF = 'off';
/**
 * Video models that took an attached clip in live API tests (2026-10-02). Only
 * Hailuo 3 also took image references with it ("replace him with @image_2");
 * Seedance failed on every video input, Aleph on a clip plus an image.
 */
const CLIP_WITH_IMAGES_VIDEO_MODEL = 'openrouter/minimax/hailuo-3';
const CLIP_VIDEO_MODELS = [CLIP_WITH_IMAGES_VIDEO_MODEL, 'openrouter/runway/aleph-2', 'openrouter/black-forest-labs/flux-video-edit'];
const SIDE_WIDTH_STORAGE_KEY = 'sessions.canvas.chatWidth';
const FILTER_STORAGE_KEY = 'sessions.canvas.filter';
/** Each chat's media as last read, and items' generation times, kept across restarts (see IStoredMediaIndex). */
const MEDIA_INDEX_STORAGE_KEY = 'sessions.canvas.mediaIndex';
/** How many items' generation times the index keeps (the newest). */
const MEDIA_INDEX_TIMES_LIMIT = 5000;

/** An item as the media index keeps it. */
interface IStoredCanvasImage {
	readonly key: string;
	readonly src: string;
	readonly label: string;
	readonly kind: CanvasMediaKind;
	readonly localFile?: string;
}

/** The media index: each chat's media as last read (by the chat's last update), and items' generation times. */
interface IStoredMediaIndex {
	readonly chats: { readonly [chat: string]: { readonly updated: number; readonly groups: readonly { readonly timestamp: number; readonly prompt?: string; readonly images: readonly IStoredCanvasImage[] }[] } };
	readonly times: { readonly [item: string]: number };
}
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


/**
 * How a message names an item: generated items share labels ("Generated
 * image"), so the label carries its file, or its URL when only hosted (never
 * an inline `data:` URL, which would paste the whole image into the message).
 */
function itemName(image: ICanvasImage): string {
	if (image.localFile) {
		return `${image.label} (${basename(image.localFile)})`;
	}
	return image.src.scheme === Schemas.data ? image.label : `${image.label} (${image.key})`;
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
	/** Writes the media index (chatMediaCache and generation times) a few seconds after it changes. */
	private readonly indexSaver = this._register(new RunOnceScheduler(() => this.saveMediaIndex(), 3000));
	private indexLoaded = false;
	/** When each item was generated, by item, as looked up (or being looked up); kept across openings. */
	private readonly mediaTimes = new Map<string, Promise<number | undefined>>();
	/** The generation times found so far, by item. */
	private readonly knownMediaTimes = new Map<string, number>();
	/** Display names of image/video models by id, learnt from the catalogs. */
	private readonly modelLabels = new Map<string, string>();
	/** The last model list read per chat and kind, so the menu opens at once. */
	private readonly modelChoices = new Map<string, ICanvasModelChoices>();
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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		// Closing restores the chat list Canvas hid, which must be saved that way; and the media index is written out.
		this._register(lifecycleService.onWillShutdown(() => {
			this.close();
			this.indexSaver.flush();
		}));
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
		// Canvas takes the chat list's place while open; Back (or Escape) brings it back.
		if (this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			store.add(toDisposable(() => {
				if (!this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
					this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
				}
			}));
		}
		this.loadMediaIndex();

		store.add(addDisposableListener(overlay, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				event.preventDefault();
				this.close();
			}
		}));

		// The title strip's drag area, which stops short of the window's own controls when they show through (see trackSidebar).
		append(overlay, $('.sessions-canvas-overlay-strip'));
		const body = append(overlay, $('.sessions-canvas-overlay-body'));
		let chatResource: URI | undefined;
		let listUploads: (saved: readonly URI[]) => Promise<ICanvasImage[]> = async () => [];
		let runEdit: (request: ICanvasEditRequest) => void = () => { };
		const blobUrls: string[] = [];
		store.add(toDisposable(() => blobUrls.forEach(url => URL.revokeObjectURL(url))));
		// One copy of each item per opening: a video's tile and stage share it rather than reading the file twice.
		const fullUrls = new Map<string, Promise<string | undefined>>();
		const fullUrl = (image: ICanvasImage) => {
			let url = fullUrls.get(image.key);
			if (!url) {
				url = this.fullUrl(image, blobUrls);
				fullUrls.set(image.key, url);
			}
			return url;
		};
		const canvas = store.add(this.instantiationService.createInstance(RightWorkbenchCanvas, body, {
			toDisplayUrl: (image, size) => size === 'thumb' && image.kind === 'image' ? this.thumbnailUrl(image) : fullUrl(image),
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
			getEditModels: tool => CANVAS_EDIT_MODELS[tool],
			runEdit: request => runEdit(request),
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
					switching++;
					void this.openChat(source.key).finally(() => switching--).then(() => canvas.focus());
				}
			},
			openLink: href => void this.openerService.open(href),
			back: () => this.close(),
		}));
		this.canvas = canvas;
		store.add(toDisposable(() => this.canvas = undefined));

		// Every chat's media on one timeline: the active chat's streams in live,
		// the others load once in the background.
		// A chat Canvas itself switched to (to show an item's own chat), which must not close it.
		let adoptedChat: string | undefined;
		// Switches to an item's chat in flight: they pass through other chats (the target session's own active chat first).
		let switching = 0;
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
			// The new chat answers with the model Canvas showed, not whatever a new chat defaults to.
			const model = chatResource && this.chatWidget(chatResource)?.input.currentLanguageModel;
			adoptNextChat = true;
			try {
				await this.sessionsService.openNewChatInSession(session);
				// Wait for the new chat's widget, which sends the message.
				for (let waited = 0; waited < 5000; waited += 100) {
					const widget = chatResource && chatResource.toString() !== previous ? this.chatWidget(chatResource) : undefined;
					if (chatResource && widget) {
						if (model && widget.input.currentLanguageModel !== model) {
							widget.input.switchModelByIdentifier(model);
						}
						return chatResource;
					}
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				// The new chat never showed up: not sending beats sending into the previous chat.
				return undefined;
			} finally {
				adoptNextChat = false;
				canvas.focus();
			}
		};
		let pendingReveal: { readonly imageUrl: string | undefined; readonly view: CanvasView | undefined } | undefined = { imageUrl, view };
		const modelStore = store.add(new DisposableStore());
		const responseListeners = store.add(new DisposableMap<object>());
		const mediaModelListener = store.add(new MutableDisposable());
		const chatModelListener = store.add(new MutableDisposable());
		let otherGroups: ICanvasImageGroup[] = [];
		let currentGroups: ICanvasImageGroup[] = [];
		let uploadGroups: ICanvasImageGroup[] = [];
		// Edits Canvas ran itself (Edit mode), dated by the time in their file names like uploads.
		let editGroups: ICanvasImageGroup[] = [];
		// Until the chat Canvas follows has loaded, its media stays as read with the other chats (so a switch never drops the shown item).
		let currentLoaded = false;
		const publish = () => {
			const currentKey = chatResource?.toString();
			const all = [...this.datedByMedia([...otherGroups.filter(group => !currentLoaded || group.source?.key !== currentKey), ...currentGroups]), ...uploadGroups, ...editGroups]
				.sort((a, b) => a.timestamp - b.timestamp);
			canvas.setGroups(all, currentKey);
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
		const listEdits = async () => {
			editGroups = await this.readEdits();
			if (this.canvas === canvas) {
				publish();
			}
		};
		void listEdits();
		runEdit = request => void this.runEdit(request, async url => {
			await listEdits();
			if (this.canvas === canvas) {
				canvas.reveal(url, 'focused');
			}
		});
		// Background changes (other chats loading, generation times found) are coalesced into one update.
		const publishScheduler = store.add(new RunOnceScheduler(() => publish(), 250));
		// Media shows at once; the timeline is re-dated as its generation times are looked up.
		const dateMedia = async (groups: readonly ICanvasImageGroup[]) => {
			if (await this.learnMediaTimes(groups)) {
				publishScheduler.schedule();
			}
		};
		// Other chats are read only while the chat Canvas shows is not loading: both wait on the agent host.
		let currentReady: Promise<void> = Promise.resolve();
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
			if (switching > 0 && key !== adoptedChat) {
				return; // On the way to the chat Canvas is switching to, not the user leaving.
			}
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
			const follow = (model: IChatModel | undefined, loading = false) => {
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
					void dateMedia(currentGroups);
					canvas.setThread(chat ? { title: chatTitle, turns: extractCanvasTurns(requests, workingDirectory), loading } : undefined);
					// Read again next time only if the chat changes (it is not among the other chats while shown).
					if (chat && model) {
						this.chatMediaCache.set(chat.resource.toString(), { updated: chat.updatedAt.get().getTime(), groups: currentGroups.map(({ source, ...group }) => group) });
						this.indexSaver.schedule();
					}
					canvas.refreshMediaModels();
				};
				modelListener.value = model?.onDidChange(() => refreshScheduler.schedule());
				refresh();
			};
			// A session's only chat may be loaded under the session's resource; with several, that model is another chat's.
			const loaded = chat ? this.chatService.getSession(chat.resource) : undefined;
			const model = loaded ?? (session && (!chat || session.chats.get().length <= 1) ? this.chatService.getSession(session.resource) : undefined);
			follow(model, !!chat && !loaded);
			// A chat Canvas switched to may not be loaded yet; hold it loaded while it is shown.
			if (chat) {
				const loading = new CancellationTokenSource();
				const ready = new DeferredPromise<void>();
				currentReady = ready.p;
				modelStore.add(toDisposable(() => {
					loading.dispose(true);
					void ready.complete();
				}));
				void this.chatService.acquireOrLoadSession(chat.resource, ChatAgentLocation.Chat, loading.token, 'sessionsCanvas').then(reference => {
					void ready.complete();
					if (loading.token.isCancellationRequested) {
						reference?.dispose();
					} else if (reference) {
						modelStore.add(reference);
						follow(reference.object);
					} else {
						follow(model);
					}
				}, () => {
					void ready.complete();
					if (!loading.token.isCancellationRequested) {
						follow(model); // The thread shows what was loaded, without the loading row.
					}
				});
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
		this.loadOtherChatGroups(chatResource?.toString(), otherChats.token, () => currentReady, groups => {
			otherGroups = [...otherGroups, ...groups];
			publishScheduler.schedule();
			void dateMedia(groups);
		}, store);

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
			// With the sidebar hidden, its toggle and the mode switch sit in the title strip under
			// Canvas. That stretch of the strip stays see-through and clickable; a clip-path would do
			// it too, but it stops the playground's glass from blurring what lies behind it.
			const origin = container.getBoundingClientRect();
			// The Simple window docks them at the window's top-left; otherwise the leftmost header
			// holds them (with the chat grid split, every cell has a header).
			const dock = left > 0 ? undefined : container.querySelector<HTMLElement>(':scope > .sessions-window-controls-dock .sessions-panel-header-left');
			const header = left > 0 || dock ? undefined : [...container.querySelectorAll<HTMLElement>('.sessions-panel-header-left')]
				.filter(element => element.getClientRects().length && element.getBoundingClientRect().top - origin.top < 40)
				.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
			const controlsRight = Math.max(0, ...[...dock ? [dock] : header?.querySelectorAll<HTMLElement>('.panel-header-fallback-left') ?? []]
				.map(controls => controls.getBoundingClientRect())
				.filter(rect => rect.width > 0)
				.map(rect => Math.ceil(rect.right - origin.left)));
			overlay.classList.toggle('shows-window-controls', controlsRight > 0);
			overlay.style.setProperty('--canvas-window-controls', `${controlsRight}px`);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(container);
		const sidebar = this.layoutService.getContainer(mainWindow, Parts.SIDEBAR_PART);
		if (sidebar) {
			observer.observe(sidebar);
		}
		store.add(toDisposable(() => observer.disconnect()));
		// The header renders its fallback controls after the sidebar hides: measure again once it has.
		const nextFrame = store.add(new MutableDisposable());
		store.add(this.layoutService.onDidChangePartVisibility(() => {
			update();
			nextFrame.value = scheduleAtNextAnimationFrame(getWindow(overlay), update);
		}));
	}

	/**
	 * Media from the most recently updated other chats, newest chat first,
	 * each group labelled with its chat. Chat models are loaded only long
	 * enough to read their responses, each after `waitTurn` (the shown chat goes first).
	 */
	private loadOtherChatGroups(currentChat: string | undefined, token: CancellationTokenSource['token'], waitTurn: () => Promise<void>, onChat: (groups: ICanvasImageGroup[]) => void, store: DisposableStore): void {
		// The session list fills in after a reload, so sessions (and chats) that show up later are read too.
		// The chat Canvas opened on is read live, and keeps its media on the timeline if Canvas leaves it.
		const queued = new Set<string>(currentChat ? [currentChat] : []);
		const queue: { readonly session: ISession; readonly chat: IChat }[] = [];
		let readers = 0;
		const enqueue = (sessions: readonly ISession[]) => {
			const fresh = sessions
				.filter(session => !session.isArchived.get())
				.flatMap(session => session.chats.get().map(chat => ({ session, chat })))
				.filter(({ chat }) => !chat.isArchived.get() && !queued.has(chat.resource.toString()))
				.sort((a, b) => b.chat.updatedAt.get().getTime() - a.chat.updatedAt.get().getTime())
				.slice(0, OTHER_CHATS_LIMIT - queued.size);
			for (const entry of fresh) {
				queued.add(entry.chat.resource.toString());
				queue.push(entry);
			}
			queue.sort((a, b) => b.chat.updatedAt.get().getTime() - a.chat.updatedAt.get().getTime());
			for (; readers < OTHER_CHATS_CONCURRENCY && queue.length; readers++) {
				void readNext().finally(() => readers--);
			}
		};
		const readNext = async (): Promise<void> => {
			for (let next = queue.shift(); next && !token.isCancellationRequested; next = queue.shift()) {
				const { session, chat } = next;
				const key = chat.resource.toString();
				const updated = chat.updatedAt.get().getTime();
				let groups = this.chatMediaCache.get(key);
				// A chat unchanged since Canvas last read it reuses that read.
				if (groups?.updated !== updated) {
					try {
						await waitTurn();
						if (token.isCancellationRequested) {
							return;
						}
						const reference = await this.chatService.acquireOrLoadSession(chat.resource, ChatAgentLocation.Chat, token, 'sessionsCanvas');
						if (!reference) {
							continue;
						}
						try {
							const workingDirectory = session.workspace.get()?.folders[0]?.workingDirectory;
							groups = { updated, groups: extractCanvasImageGroups(reference.object.getRequests(), workingDirectory) };
							this.chatMediaCache.set(key, groups);
							this.indexSaver.schedule();
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
		enqueue(this.sessionsManagementService.getSessions());
		store.add(this.sessionsManagementService.onDidChangeSessions(event => {
			if (!token.isCancellationRequested) {
				enqueue([...event.added, ...event.changed]);
			}
		}));
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
	 * across openings; hosted-only images show their original.
	 */
	private thumbnailUrl(image: ICanvasImage): Promise<string | undefined> {
		let url = this.thumbnailUrls.get(image.key);
		if (!url) {
			url = this.makeThumbnail(image);
			this.thumbnailUrls.set(image.key, url);
			void url.then(made => {
				if (!made) {
					this.thumbnailUrls.delete(image.key);
				}
			});
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


	/**
	 * The chat's own widget. Never another chat's (such as the last focused):
	 * an edit or model change must not land in a chat the user isn't looking at.
	 */
	private chatWidget(chatResource: URI) {
		return this.chatWidgetService.getWidgetBySessionResource(chatResource);
	}

	/** The chat's model picker for this kind: the model list, or the older on/off image switch. */
	private mediaOption(chatResource: URI, kind: CanvasMediaKind) {
		const widget = this.chatWidget(chatResource);
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
			this.modelChoices.set(`${chatResource}|${kind}`, models);
			return models;
		});
		const cached = this.modelChoices.get(`${chatResource}|${kind}`);
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
		const widget = this.chatWidget(chatResource);
		if (!widget || !images.length) {
			this.warnNotSent();
			return;
		}
		const option = this.mediaOption(chatResource, kind);
		if (option && !option.active && option.activationValue) {
			// Turn on the generator the user picked in Canvas, with the chat's default model.
			option.setValue(option.activationValue);
		}
		if (option && kind === 'video' && images.some(image => image.kind === 'video')) {
			// A clip only reaches models that take video input; move the chat to one when its pick can't.
			const accepted = images.some(image => image.kind !== 'video') ? [CLIP_WITH_IMAGES_VIDEO_MODEL] : CLIP_VIDEO_MODELS;
			if (!accepted.includes(option.getEnumInfo()?.current ?? '')) {
				const catalog = await Promise.resolve(option.getDynamicEnumInfo?.() ?? option.getEnumInfo()).catch(() => undefined);
				if (catalog?.values.includes(CLIP_WITH_IMAGES_VIDEO_MODEL)) {
					option.setValue(CLIP_WITH_IMAGES_VIDEO_MODEL);
				}
			}
		}
		await this.setComposerImages(chatResource, images);
		const subject = (image: ICanvasImage) => image.kind === 'video' ? localize('sessionsCanvas.videoSubject', "{0}, a video", itemName(image)) : itemName(image);
		let message: string;
		if (images.length === 1) {
			const [image] = images;
			const named = `${subject(image)}, @${referenceName(0)}`;
			message = kind === 'video'
				? image.kind === 'video'
					// Worded as a new video guided by the clip, the phrasing video models followed in live tests.
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
					? images.some(image => image.kind === 'video')
						// Reference wording: the new video follows the clip, with the stills built in.
						? localize('sessionsCanvas.videoFromClipAndImages', "Make a new video that follows the attached video's camera motion, framing, movement and scene, using the attached images as references. They are referred to as:\n{0}\n\n{1}", legend, prompt)
						: localize('sessionsCanvas.videoFromImages', "Make a video from the attached images. They are referred to as:\n{0}\n\n{1}", legend, prompt)
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
			// Canvas lists only these types: anything else (HEIC, TIFF, SVG) would be saved and never shown.
			if (!UPLOAD_EXTENSIONS.includes(entry.name.split('.').pop()?.toLowerCase() ?? '')) {
				this.notificationService.warn(localize('sessionsCanvas.uploadUnsupported', "Canvas can't show {0}. Upload a PNG, JPEG, WebP, GIF, AVIF or BMP image, or an MP4, MOV, M4V or WebM video.", entry.name));
				continue;
			}
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

	/**
	 * Reads the media index an earlier run saved, once. Chats unchanged since
	 * are not restored again (restoring every chat on each launch kept the
	 * agent host busy for minutes, starving the chat Canvas shows).
	 */
	private loadMediaIndex(): void {
		if (this.indexLoaded) {
			return;
		}
		this.indexLoaded = true;
		const index = this.storageService.getObject<IStoredMediaIndex>(MEDIA_INDEX_STORAGE_KEY, StorageScope.PROFILE);
		for (const [chat, entry] of Object.entries(index?.chats ?? {})) {
			if (!this.chatMediaCache.has(chat)) {
				this.chatMediaCache.set(chat, {
					updated: entry.updated,
					groups: entry.groups.map(group => ({
						timestamp: group.timestamp,
						prompt: group.prompt,
						images: group.images.map(image => ({ key: image.key, src: URI.parse(image.src), label: image.label, kind: image.kind, localFile: image.localFile ? URI.parse(image.localFile) : undefined })),
					})),
				});
			}
		}
		for (const [item, time] of Object.entries(index?.times ?? {})) {
			if (!this.knownMediaTimes.has(item)) {
				this.knownMediaTimes.set(item, time);
				this.mediaTimes.set(item, Promise.resolve(time));
			}
		}
	}

	private saveMediaIndex(): void {
		const existing = new Set(this.sessionsManagementService.getSessions().flatMap(session => session.chats.get().map(chat => chat.resource.toString())));
		const chats: Record<string, IStoredMediaIndex['chats'][string]> = {};
		for (const [chat, entry] of this.chatMediaCache) {
			// Deleted chats go; inline media would bloat the index, so such chats are read again instead.
			if ((existing.size && !existing.has(chat)) || entry.groups.some(group => group.images.some(image => image.key.startsWith('data:')))) {
				continue;
			}
			chats[chat] = {
				updated: entry.updated,
				groups: entry.groups.map(group => ({
					timestamp: group.timestamp,
					prompt: group.prompt,
					images: group.images.map(image => ({ key: image.key, src: image.src.toString(), label: image.label, kind: image.kind, localFile: image.localFile?.toString() })),
				})),
			};
		}
		const times = Object.fromEntries([...this.knownMediaTimes].filter(([item]) => !item.startsWith('data:')).slice(-MEDIA_INDEX_TIMES_LIMIT));
		this.storageService.store(MEDIA_INDEX_STORAGE_KEY, JSON.stringify({ chats, times } satisfies IStoredMediaIndex), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	/**
	 * Each turn dated by when its media was generated (its newest item). A chat
	 * loaded from disk replays every turn with the load time, so request times
	 * alone put a restored chat's media all at one time, and inside or outside
	 * "recent" filters wholesale. Turns with no known media time keep the
	 * request time.
	 */
	private datedByMedia(groups: readonly ICanvasImageGroup[]): ICanvasImageGroup[] {
		return groups.map(group => {
			const times = group.images.map(image => this.knownMediaTimes.get(image.key)).filter(isDefined);
			return times.length ? { ...group, timestamp: Math.max(...times) } : group;
		});
	}

	/** Looks up the generation time of items not dated yet; whether any were. */
	private async learnMediaTimes(groups: readonly ICanvasImageGroup[]): Promise<boolean> {
		const lookups = groups.flatMap(group => group.images).filter(image => !this.knownMediaTimes.has(image.key)).map(image => this.mediaTime(image));
		const learnt = lookups.length > 0 && (await Promise.all(lookups)).some(isDefined);
		if (learnt) {
			this.indexSaver.schedule();
		}
		return learnt;
	}

	/**
	 * When an item was generated: the earliest of its host's upload time (kept
	 * however the local copy is later rewritten, e.g. by git) and its saved
	 * file's creation time (the only one for inline images).
	 */
	private mediaTime(image: ICanvasImage): Promise<number | undefined> {
		let time = this.mediaTimes.get(image.key);
		if (!time) {
			time = Promise.all([this.hostedMediaTime(image), this.savedMediaTime(image)]).then(times => {
				const known = times.filter(isDefined);
				if (!known.length) {
					return undefined;
				}
				const earliest = Math.min(...known);
				this.knownMediaTimes.set(image.key, earliest);
				return earliest;
			});
			this.mediaTimes.set(image.key, time);
		}
		return time;
	}

	private async hostedMediaTime(image: ICanvasImage): Promise<number | undefined> {
		if (!/^https:/i.test(image.key)) {
			return undefined;
		}
		try {
			return await this.commandService.executeCommand<number | undefined>(CANVAS_HOSTED_MEDIA_TIME_COMMAND_ID, image.key);
		} catch {
			return undefined; // Not on desktop.
		}
	}

	private async savedMediaTime(image: ICanvasImage): Promise<number | undefined> {
		if (!image.localFile) {
			return undefined;
		}
		try {
			const stat = await this.fileService.stat(image.localFile);
			// Creation time survives the CLI re-saving the same file; a copy that kept its modified time is older still.
			const times = [stat.ctime, stat.mtime].filter(time => time > 0);
			return times.length ? Math.min(...times) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Runs an Edit-mode request straight against the media API (no chat
	 * model involved), showing progress until the result is recorded;
	 * `onDone` lists it and shows it. Canvas may close meanwhile: the result
	 * is recorded anyway and appears next time.
	 */
	private async runEdit(request: ICanvasEditRequest, onDone: (url: string) => Promise<void>): Promise<void> {
		const model = CANVAS_EDIT_MODELS[request.tool].find(candidate => candidate.id === request.model);
		if (!model) {
			return;
		}
		const progress = this.notificationService.notify({
			severity: Severity.Info,
			message: localize('sessionsCanvas.editRunning', "Editing {0} with {1}. This usually takes 2–5 minutes.", request.video.label, model.label),
			progress: { infinite: true },
		});
		try {
			const record = await runCanvasEdit(request, model, { fileService: this.fileService, pathService: this.pathService, configurationService: this.configurationService }, mainWindow);
			progress.close();
			await onDone(record.url);
			if (record.referencesDropped) {
				this.notificationService.info(localize('sessionsCanvas.editNoReferences', "Edited from your description only: Backboard can't pass reference photos to {0} yet.", model.label));
			}
		} catch (error) {
			progress.close();
			const message = error instanceof CanvasEditError ? error.message : error instanceof Error ? error.message : String(error);
			this.notificationService.error(localize('sessionsCanvas.editFailed', "Couldn't edit {0}: {1}", request.video.label, message));
		}
	}

	/** Edit-mode results as Canvas items, one group per edit, headed by its prompt and shown from its link. */
	private async readEdits(): Promise<ICanvasImageGroup[]> {
		const folder = joinPath(await this.pathService.userHome(), '.backboard', CANVAS_EDITS_FOLDER);
		let children;
		try {
			children = (await this.fileService.resolve(folder)).children ?? [];
		} catch {
			return []; // No edits yet.
		}
		const source = { key: CANVAS_EDITS_FOLDER, title: localize('sessionsCanvas.edited', "Edited") };
		const groups: ICanvasImageGroup[] = [];
		for (const child of children) {
			const match = /^(?<time>\d{13})-.+\.json$/.exec(child.name);
			if (child.isDirectory || !match?.groups) {
				continue;
			}
			let record: ICanvasEditRecord;
			try {
				record = JSON.parse((await this.fileService.readFile(child.resource)).value.toString());
			} catch {
				continue;
			}
			if (typeof record.url !== 'string' || !/^https:/.test(record.url)) {
				continue;
			}
			groups.push({
				timestamp: Number(match.groups.time),
				images: [{ key: record.url, src: URI.parse(record.url), label: localize('sessionsCanvas.editOf', "Edit of {0}", record.source), kind: 'video', localFile: undefined }],
				source,
				...(record.prompt ? { prompt: record.prompt } : {}),
			});
		}
		return groups;
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
		const fallbackName = image.kind === 'video' ? 'video.mp4' : 'image.png';
		const name = (image.localFile ? basename(image.localFile) : image.src.scheme === Schemas.data ? undefined : basename(image.src)) || fallbackName;
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
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
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
		const widget = this.chatWidget(chatResource);
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
		const widget = this.chatWidget(chatResource);
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
		const widget = this.chatWidget(chatResource);
		if (!widget) {
			this.warnNotSent();
			return;
		}
		await this.setComposerImages(chatResource, [...comments.keys()]);
		const lines: string[] = [localize('sessionsCanvas.batchEditIntro', "Edit these images based on my comments:")];
		let number = 0;
		for (const [image, notes] of comments) {
			lines.push('', itemName(image));
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

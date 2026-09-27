/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, DragAndDropObserver, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { safeIntl } from '../../../../base/common/date.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isDefined } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IChatToolInvocation } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { isImageVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { IChatProgressResponseContent, IChatRequestModel } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { isToolResultInputOutputDetails } from '../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { ChatQuestionCarouselData } from '../../../../workbench/contrib/chat/common/model/chatProgressTypes/chatQuestionCarouselData.js';
import { renderGeneratedImagePlaceholder } from '../../../../workbench/contrib/chat/browser/widget/chatGeneratedImageGallery.js';
import { applyCodexRoot, CodexCadencedShimmer, cxEl } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/codex/codexDom.js';
import { modelBrandIconKeyForName } from '../../../../workbench/contrib/chat/browser/widget/input/combinedModelProviderPickerActionItem.js';

export type CanvasMediaKind = 'image' | 'video';

/** One image or video produced in a chat, as shown on the canvas. */
export interface ICanvasImage {
	/** Stable identity across refreshes: the media URL. */
	readonly key: string;
	/** What the tile displays (the hosted URL, or a workspace file). */
	readonly src: URI;
	readonly label: string;
	readonly kind: CanvasMediaKind;
	/** The copy the CLI saved into the session folder, attachable to the composer. */
	readonly localFile: URI | undefined;
	/** The user uploaded it (Canvas keeps it even when it cannot be previewed, e.g. an HEVC video). */
	readonly uploaded?: boolean;
}

/** Another chat whose media the canvas also shows, clearly labelled as such. */
export interface ICanvasSource {
	readonly key: string;
	readonly title: string;
}

/** The media one turn produced, shown as a row under its time. */
export interface ICanvasImageGroup {
	readonly timestamp: number;
	readonly images: readonly ICanvasImage[];
	/** Set when the turn belongs to another chat than the one Canvas follows. */
	readonly source?: ICanvasSource;
	/** What the user asked for in that turn. */
	readonly prompt?: string;
	/** The agent's written answer, without the media links. */
	readonly reply?: string;
}

/** A note pinned to a point of an image while batch-editing in comment mode. */
export interface ICanvasComment {
	/** Pin position as a fraction of the image's width and height. */
	readonly x: number;
	readonly y: number;
	readonly text: string;
}

/**
 * Matches the markdown the Backboard CLI appends for generated media:
 * `![label](url)` optionally followed by "Saved to `generated-images/…`.".
 */
const GENERATED_IMAGE_MARKDOWN = /!\[(?<label>[^\]]*)\]\(\s*(?<url>[^)\s]+)\s*\)(?:\s*Saved to `(?<saved>[^`]+)`)?/g;
const VIDEO_EXTENSION = /\.(?:mp4|mov|webm|m4v)(?:[?#].*)?$/i;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|bmp)(?:[?#].*)?$/i;
/** Where Backboard's hosted generators put their output. */
const GENERATED_MEDIA_PATH = /\/generated-(?:image|video)s?\//i;
/** Fenced code blocks and inline code: media links quoted there are examples, not output. */
const MARKDOWN_CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * Whether a markdown image link points at real media: an image or video
 * file, a generated-media URL, or inline image/video data — not a
 * placeholder like `url`, and not a link the agent shortened with an ellipsis.
 */
function isMediaUrl(url: string, saved: string | undefined): boolean {
	if (/…|\.\.\./.test(url)) {
		return false;
	}
	if (/^data:(?:image|video)\//i.test(url)) {
		return true;
	}
	return IMAGE_EXTENSION.test(url) || VIDEO_EXTENSION.test(url) || GENERATED_MEDIA_PATH.test(url) || (!!saved && (IMAGE_EXTENSION.test(saved) || VIDEO_EXTENSION.test(saved)));
}

/** An image the user attached to a message, shown above it in the thread. */
export interface ICanvasAttachment {
	readonly label: string;
	/** Pasted or dropped image bytes. */
	readonly data?: Uint8Array;
	readonly mimeType?: string;
	/** An attached image file. */
	readonly uri?: URI;
}

/** One exchange of the chat shown beside an item, like Runway's agent thread. */
export interface ICanvasTurn {
	readonly id: string;
	readonly prompt: string;
	readonly attachments: readonly ICanvasAttachment[];
	/** The agent's answer as markdown, without the media links it rendered. */
	readonly reply: string;
	/** The images and videos this turn produced. */
	readonly media: readonly ICanvasImage[];
	/** The agent is still answering. */
	readonly inProgress: boolean;
	/** A question the agent is waiting on (e.g. the video length); answered from the thread. */
	readonly question?: ChatQuestionCarouselData;
	/** An image or video generation still running in this turn. */
	readonly generating?: CanvasMediaKind;
}

/** The chat Canvas shows beside the focused item. */
export interface ICanvasThread {
	readonly title: string;
	readonly turns: readonly ICanvasTurn[];
}

/** Numbering state shared across a chat's turns, so labels match everywhere. */
interface IMediaScan {
	readonly seen: Set<string>;
	images: number;
	videos: number;
}

/** The media a response rendered that no earlier turn showed. */
function scanMedia(request: IChatRequestModel, workingDirectory: URI | undefined, scan: IMediaScan): ICanvasImage[] {
	const response = request.response;
	if (!response) {
		return [];
	}
	// Saved-to paths are in backticks, so code is blanked (keeping `Saved to` intact) rather than removed.
	const text = response.response.value.map(partText).join('\n').replace(MARKDOWN_CODE, code => /^`generated-/.test(code) ? code : ' ');
	const images: ICanvasImage[] = [];
	for (const match of text.matchAll(GENERATED_IMAGE_MARKDOWN)) {
		const url = match.groups?.url;
		if (!url || scan.seen.has(url) || !isMediaUrl(url, match.groups?.saved)) {
			continue;
		}
		const src = resolveImageUri(url, workingDirectory);
		if (!src) {
			continue;
		}
		scan.seen.add(url);
		const saved = match.groups?.saved;
		const kind: CanvasMediaKind = VIDEO_EXTENSION.test(url) || (!!saved && VIDEO_EXTENSION.test(saved)) ? 'video' : 'image';
		const fallbackLabel = kind === 'video'
			? localize('rightWorkbench.canvas.generatedVideo', "Generated video {0}", ++scan.videos)
			: localize('rightWorkbench.canvas.generatedImage', "Generated image {0}", ++scan.images);
		images.push({
			key: url,
			src,
			label: match.groups?.label?.trim() || fallbackLabel,
			kind,
			localFile: saved && workingDirectory ? joinPath(workingDirectory, saved) : src.scheme === 'file' ? src : undefined,
		});
	}
	return images;
}

/** The response's written answer, with the media links (shown as tiles instead) removed. */
function replyMarkdown(request: IChatRequestModel): string {
	return (request.response?.response.value ?? [])
		.map(part => part.kind === 'markdownContent' ? part.content.value : '')
		.join('\n')
		.replace(GENERATED_IMAGE_MARKDOWN, '')
		.replace(/^[ \t]*\.[ \t]*$/gm, '') // the period left after "Saved to `…`"
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Collects the images and videos each response rendered, oldest turn first.
 * An item is listed once, in the turn that first showed it.
 */
export function extractCanvasImageGroups(requests: readonly IChatRequestModel[], workingDirectory: URI | undefined): ICanvasImageGroup[] {
	const scan: IMediaScan = { seen: new Set(), images: 0, videos: 0 };
	const groups: ICanvasImageGroup[] = [];
	for (const request of requests) {
		const images = scanMedia(request, workingDirectory, scan);
		if (images.length && request.response) {
			groups.push({
				timestamp: request.response.timestamp || request.timestamp,
				images,
				prompt: request.message.text.trim() || undefined,
				reply: replyMarkdown(request) || undefined,
			});
		}
	}
	return groups;
}

/** Every exchange of a chat, with its attachments, answer, and media, for the thread beside the focused item. */
export function extractCanvasTurns(requests: readonly IChatRequestModel[], workingDirectory: URI | undefined): ICanvasTurn[] {
	const scan: IMediaScan = { seen: new Set(), images: 0, videos: 0 };
	return requests.map(request => ({
		id: request.id,
		prompt: request.message.text.trim(),
		attachments: request.variableData.variables.filter(isImageVariableEntry).map(entry => {
			const reference = entry.references?.[0]?.reference;
			return {
				label: entry.name,
				data: entry.value instanceof Uint8Array ? entry.value : undefined,
				mimeType: entry.mimeType,
				uri: URI.isUri(entry.value) ? entry.value : URI.isUri(reference) ? reference : undefined,
			};
		}),
		reply: replyMarkdown(request),
		media: scanMedia(request, workingDirectory, scan),
		inProgress: !request.response || !request.response.isComplete,
		...liveTurnState(request),
	}));
}

/**
 * What a running turn is waiting on: an unanswered question (the chat shows
 * it above its own composer, which the Canvas overlay covers, so the thread
 * must show it or the turn stalls) and a media generation still in flight.
 */
function liveTurnState(request: IChatRequestModel): { question?: ChatQuestionCarouselData; generating?: CanvasMediaKind } {
	const response = request.response;
	if (!response || response.isComplete) {
		return {};
	}
	let question: ChatQuestionCarouselData | undefined;
	let generating: CanvasMediaKind | undefined;
	for (const part of response.response.value) {
		if (part instanceof ChatQuestionCarouselData && !part.isUsed) {
			question = part;
		} else if (part.kind === 'toolInvocation' && !IChatToolInvocation.isComplete(part)) {
			const media = /generate[_-]?(?<media>image|video)/i.exec(part.toolId)?.groups?.media?.toLowerCase();
			if (media === 'image' || media === 'video') {
				generating = media;
			}
		}
	}
	return { ...(question ? { question } : {}), ...(generating ? { generating } : {}) };
}

/**
 * The text an image link can appear in: the response markdown, or the
 * `generate_image` tool's result, which carries the same `![…](…)` plus
 * "Saved to …" detail when the final answer omits it.
 */
function partText(part: IChatProgressResponseContent): string {
	if (part.kind === 'markdownContent') {
		return part.content.value;
	}
	if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
		const details = IChatToolInvocation.resultDetails(part);
		if (isToolResultInputOutputDetails(details)) {
			return details.output.map(output => output.type === 'embed' && output.isText ? output.value : '').join('\n');
		}
	}
	return '';
}

function resolveImageUri(url: string, workingDirectory: URI | undefined): URI | undefined {
	if (/^(?:https?:|data:(?:image|video)\/)/i.test(url)) {
		return URI.parse(url);
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		return undefined; // Other schemes (javascript:, command:, …) are never images here.
	}
	return workingDirectory ? joinPath(workingDirectory, url) : undefined;
}

/** The models a chat offers for one kind of generation. */
export interface ICanvasModelChoices {
	readonly values: readonly string[];
	readonly labels: readonly string[];
	readonly current: string | undefined;
}

/** How a Canvas message is sent. */
export interface ICanvasSendOptions {
	/** Start a new chat for it (an upload has no chat of its own yet). */
	readonly newChat?: boolean;
}

/** The chat's language models, for the thread header's model picker. */
export interface ICanvasChatModels {
	readonly models: readonly { readonly id: string; readonly label: string }[];
	readonly current: string | undefined;
}

/** The chat's current image or video model, as the canvas composer shows it. */
export interface ICanvasMediaModel {
	/** Whether the chat composer has this kind of generation turned on. */
	readonly active: boolean;
	/** The selected model's name, when active. */
	readonly label: string | undefined;
}

/** The maker's logo for a media model (the chat model picker's brand icons), Backboard's when unknown. */
function modelLogoKey(name: string): string {
	return modelBrandIconKeyForName(name) ?? 'backboard';
}

function groupsSignature(groups: readonly ICanvasImageGroup[]): string {
	return groups.map(group => `${group.source?.key ?? ''}@${group.timestamp}:${group.images.map(image => image.key).join(',')}`).join('|');
}

export interface IRightWorkbenchCanvasDelegate {
	/**
	 * Resolves an item's displayable URL (e.g. a blob URL for workspace files):
	 * a small `thumb` for tiles and filmstrips, the `full` item for the stage.
	 */
	toDisplayUrl(image: ICanvasImage, size: CanvasMediaSize): Promise<string | undefined>;
	/** Makes these images the canvas-owned attachments of the chat composer. */
	setComposerImages(images: readonly ICanvasImage[]): void;
	/** Sends one batch-edit request for the commented images. */
	sendComments(comments: ReadonlyMap<ICanvasImage, readonly ICanvasComment[]>): void;
	/**
	 * Sends `prompt` to the chat with `images` attached (the prompt names them
	 * `@image_1`, `@image_2`, … in this order), as an image edit or a video made
	 * from them; `seconds` is the chosen video length, if any.
	 */
	sendEdit(images: readonly ICanvasImage[], prompt: string, kind: CanvasMediaKind, seconds: number | undefined, options?: ICanvasSendOptions): void;
	/** The chat's image/video model, or `undefined` when the chat cannot generate that kind. */
	getMediaModel(kind: CanvasMediaKind): ICanvasMediaModel | undefined;
	/** The models the chat offers for this kind, with the current one, for the composer's model menu. */
	getModelChoices?(kind: CanvasMediaKind): Promise<ICanvasModelChoices | undefined>;
	/** The chat's language model (what answers in the thread) and the ones it can switch to. */
	getChatModels?(): ICanvasChatModels | undefined;
	/** Switches the chat's language model. */
	setChatModel?(id: string): void;
	/** Picks the chat's image/video model, turning that kind of generation on. */
	setModel?(kind: CanvasMediaKind, value: string): void;
	/** Saves dropped image/video files to Canvas's uploads and returns them as items (already listed). */
	uploadFiles?(files: readonly File[]): Promise<readonly ICanvasImage[]>;
	/** Lets the user pick image/video files to upload, and returns them as items (already listed). */
	pickUploads?(): Promise<readonly ICanvasImage[]>;
	/** The saved filter, and where to save a new one. */
	readonly filter?: ICanvasFilter;
	saveFilter?(filter: ICanvasFilter): void;
	/** The chat panel's saved width, and where to save a new one. */
	readonly sideWidth?: number;
	saveSideWidth?(width: number): void;
	/**
	 * Extra actions for an item, offered on right-click and, in the focused
	 * view, behind a "More Actions" button. Canvas offers none when unset.
	 */
	getItemActions?(image: ICanvasImage): readonly IAction[];
	/** Saves a copy of the item where the user picks. */
	saveAs?(image: ICanvasImage): void;
	/** Shows the item's saved file in the OS file manager. */
	revealInOS?(image: ICanvasImage): void;
	/** Sends `prompt` to the chat as a plain message (nothing attached). */
	sendMessage?(prompt: string, options?: ICanvasSendOptions): void;
	/** Makes the chat an item came from the one the thread shows and messages go to. */
	focusSourceChat?(source: ICanvasSource): void;
	/** Opens a link from the thread. */
	openLink?(href: string): void;
}

export type CanvasView = 'canvas' | 'focused';

/** Which items Canvas lists, and in what order. */
export interface ICanvasFilter {
	readonly order: 'newest' | 'oldest';
	readonly range: 'all' | 'day' | 'week' | 'month';
	readonly kind: 'all' | CanvasMediaKind;
}

export const DEFAULT_CANVAS_FILTER: ICanvasFilter = { order: 'newest', range: 'all', kind: 'all' };
const RANGE_MS = { day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000 };
/** The chat panel beside the focused item: Runway's width, and how far it can be dragged. */
const DEFAULT_SIDE_WIDTH = 380;
const MIN_SIDE_WIDTH = 300;
const MAX_SIDE_WIDTH = 720;
/** Narrowest asset stage the chat panel may leave when the window shrinks. */
const MIN_STAGE_WIDTH = 360;

/** How the composer and the sent message name the n-th reference (from 0): `image_1`, `image_2`, … */
export function referenceName(index: number): string {
	return `image_${index + 1}`;
}

/**
 * Whether a prompt gives different references their own instructions —
 * `@image_1 make it flip the hat` / `@image_2 make it throw the ball` — so
 * each should get its own output, rather than one output combining them
 * (`put the hat from @image_1 on @image_2`). True when at least two
 * different references each start a line or sentence.
 */
export function hasPerReferenceInstructions(prompt: string): boolean {
	const leading = new Set<string>();
	for (const match of prompt.matchAll(/(?:^|[\n.;!?])\s*@image_(\d+)\b/g)) {
		leading.add(match[1]);
	}
	return leading.size >= 2;
}

function clampSideWidth(width: number): number {
	return Math.round(Math.min(MAX_SIDE_WIDTH, Math.max(MIN_SIDE_WIDTH, width)));
}
export type CanvasMediaSize = 'thumb' | 'full';

const CANVAS_ZOOM_LEVELS = [0.25, 0.5, 1, 1.5, 2];
/** Drag data type for a Canvas item dragged onto the composer (its key). */
const CANVAS_ITEM_MIME = 'application/vnd.backboard.canvas-item';
/** Video lengths the composer offers — the same choices the agent's "Video length" question gives. */
const VIDEO_LENGTH_SECONDS = [5, 8, 10, 15];

/** `0:08`, `1:05`: a video's length for its badge. */
export function formatVideoLength(seconds: number): string | undefined {
	if (!isFinite(seconds) || seconds <= 0) {
		return undefined;
	}
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
const timeFormatter = safeIntl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The image playground: every image and video from the chat — and, labelled
 * as such, from the user's other chats — as a zoomable grid grouped by turn,
 * and a Runway-style focused view: the item large with a filmstrip of
 * everything, and beside it the chat it came from with a composer that edits
 * the shown item (or makes a video from it) or just talks to the agent. Behaviour
 * mirrors Codex: a click selects (a second click keeps it selected),
 * Multi-Select toggles items in and out, and Comment mode pins numbered notes
 * onto images and sends them as one batch edit.
 */
export class RightWorkbenchCanvas extends Disposable {
	private readonly renderStore = this._register(new DisposableStore());
	private readonly root: HTMLElement;
	/** Re-rendered on every change; the composer beside it persists so a draft survives streaming. */
	private readonly body: HTMLElement;
	/** The focused view's chat: a live thread above the composer, kept across renders. */
	private readonly side: HTMLElement;
	private readonly threadTitle: HTMLElement;
	/** The thread header's chat model chip (the chat's language model). */
	private readonly chatModelButton: HTMLButtonElement;
	private readonly threadScroll: HTMLElement;
	private readonly threadStore = this._register(new DisposableStore());
	private thread: ICanvasThread | undefined;
	private threadSignature: string | undefined;
	/** Blob URLs for pasted attachments, by turn and index, revoked on dispose. */
	private readonly attachmentUrls = new Map<string, string>();
	private readonly composer: HTMLFormElement;
	/** The composer's reference slot: the shown item, attached unless removed. */
	private readonly composerAttachments: HTMLElement;
	private readonly composerStore = this._register(new DisposableStore());
	/** The composer's open menu (models or video length), and the button it belongs to. */
	private readonly composerMenu = this._register(new MutableDisposable<DisposableStore>());
	private composerMenuAnchor: HTMLElement | undefined;
	/** Media elements kept across renders by slot and item, so re-rendering never reloads (and flashes) them. */
	private readonly mediaPool = new Map<string, HTMLImageElement | HTMLVideoElement>();
	/** The chat panel's width, set by dragging its edge. */
	private sideWidth: number;
	/** Recent-only, kind, and order for the grid and the filmstrip. */
	private filter: ICanvasFilter;
	/**
	 * The composer's references, in `@image_N` order: the shown item by
	 * default, or every image picked with Multi-Select. Kept as item keys.
	 */
	private references: string[] = [];
	/** The `@` suggestions under the composer while a mention is being typed. */
	private readonly mentionMenu = this._register(new MutableDisposable<DisposableStore>());
	private mentionIndex = 0;
	private readonly composerInput: HTMLTextAreaElement;
	private readonly composerModes: HTMLElement;
	private readonly composerModel: HTMLButtonElement;
	private readonly composerLength: HTMLButtonElement;
	private readonly composerSend: HTMLButtonElement;
	private composerKind: CanvasMediaKind = 'image';
	/** Chosen video length for the next send; unset (Auto) lets the agent choose or ask. */
	private composerSeconds: number | undefined;
	/** Set after sending an edit: the next new item in this chat becomes the focused one. */
	private awaitingResult: ReadonlySet<string> | undefined;
	private groups: readonly ICanvasImageGroup[] = [];
	private otherGroups: readonly ICanvasImageGroup[] = [];
	private view: CanvasView = 'canvas';
	private canvasZoom = 1;
	/** The asset view's zoom: fitted to the stage, or a fixed scale. */
	private focusedZoom: number | 'fit' = 'fit';
	private multiSelect = false;
	private commentMode = false;
	private readonly selected = new Set<string>();
	private readonly comments = new Map<string, ICanvasComment[]>();
	/** The unsaved comment being typed, if any. */
	private draft: { readonly key: string; readonly x: number; readonly y: number } | undefined;
	private readonly displayUrls = new Map<string, Promise<string | undefined>>();
	/** Display URLs already resolved, applied at once when a tile is re-rendered. */
	private readonly resolvedUrls = new Map<string, string>();
	/** Items whose media failed to load: dropped from every view. */
	private readonly broken = new Set<string>();
	/** Uploads that cannot be previewed (e.g. HEVC video): kept, shown as a "No preview" tile. */
	private readonly unpreviewable = new Set<string>();
	private readonly brokenScheduler = this._register(new RunOnceScheduler(() => this.dropBroken(), 100));
	/** Tiles and thumbs load when they scroll near view, so a long timeline stays quick. */
	private readonly lazyLoads = new Map<Element, () => void>();
	private readonly lazyObserver: IntersectionObserver;
	private focusedStage: HTMLElement | undefined;
	private chatKey: string | undefined;
	private groupsSignature: string | undefined;
	/**
	 * An upload is shown: it has no chat yet, so the chat panel is a fresh,
	 * empty one and the next message starts a new chat.
	 */
	private freshChat = false;
	/** The next render aims the grid at the selection instead of keeping its scroll position. */
	private revealPending = false;
	/** Focused view with the side panel, filmstrip and actions tucked away. */
	private expanded = false;

	constructor(
		container: HTMLElement,
		private readonly delegate: IRightWorkbenchCanvasDelegate,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		this.root = append(container, $('.sessions-right-workbench-canvas'));
		this.body = append(this.root, $('.sessions-right-workbench-canvas-body'));
		this.lazyObserver = new (getWindow(container).IntersectionObserver)(entries => {
			for (const entry of entries) {
				const load = entry.isIntersecting ? this.lazyLoads.get(entry.target) : undefined;
				if (load) {
					this.lazyLoads.delete(entry.target);
					this.lazyObserver.unobserve(entry.target);
					load();
				}
			}
		}, { rootMargin: '300px' });
		this._register(toDisposable(() => this.lazyObserver.disconnect()));

		this.side = append(this.root, $('.sessions-right-workbench-canvas-side'));
		this.side.hidden = true;
		this.sideWidth = clampSideWidth(delegate.sideWidth ?? DEFAULT_SIDE_WIDTH);
		this.filter = { ...DEFAULT_CANVAS_FILTER, ...delegate.filter };
		this.registerSideSash(append(this.side, $('.sessions-right-workbench-canvas-side-sash')));
		const threadHeader = append(this.side, $('.sessions-right-workbench-canvas-thread-header'));
		this.threadTitle = append(threadHeader, $('.sessions-right-workbench-canvas-thread-title'));
		this.chatModelButton = append(threadHeader, $('button.sessions-right-workbench-canvas-chat-model')) as HTMLButtonElement;
		this.chatModelButton.type = 'button';
		this.chatModelButton.title = localize('rightWorkbench.canvas.chatModel', "Chat Model");
		this.chatModelButton.setAttribute('aria-haspopup', 'listbox');
		this.chatModelButton.hidden = !delegate.getChatModels;
		this._register(addDisposableListener(this.chatModelButton, EventType.CLICK, () => this.toggleChatModelMenu()));
		this.threadScroll = append(this.side, $('.sessions-right-workbench-canvas-thread'));
		this._register(toDisposable(() => this.attachmentUrls.forEach(url => URL.revokeObjectURL(url))));

		// Focused-view composer: talk to the chat, editing the shown item (or making a video from it) while it is attached.
		this.composer = append(this.side, $('form.sessions-right-workbench-canvas-composer')) as HTMLFormElement;
		this.composer.hidden = true;
		this.composerAttachments = append(this.composer, $('.sessions-right-workbench-canvas-composer-attachments'));
		this.composerInput = append(this.composer, $('textarea.sessions-right-workbench-canvas-composer-input')) as HTMLTextAreaElement;
		this.composerInput.rows = 1;
		const footer = append(this.composer, $('.sessions-right-workbench-canvas-composer-footer'));
		// Runway's "+": upload images or videos to use as references.
		const upload = append(footer, $('button.sessions-right-workbench-canvas-composer-upload')) as HTMLButtonElement;
		upload.type = 'button';
		upload.title = upload.ariaLabel = localize('rightWorkbench.canvas.uploadReferences', "Upload Images or Videos");
		upload.appendChild(renderIcon(Codicon.add));
		upload.hidden = !delegate.pickUploads;
		this._register(addDisposableListener(upload, EventType.CLICK, () => {
			if (this.delegate.pickUploads) {
				void this.receiveUploads(this.delegate.pickUploads(), true);
			}
		}));
		this.composerModes = append(footer, $('.sessions-right-workbench-canvas-composer-modes'));
		this.composerModes.setAttribute('role', 'group');
		this.composerModes.ariaLabel = localize('rightWorkbench.canvas.generate', "Generate");
		for (const kind of ['image', 'video'] as const) {
			const button = append(this.composerModes, $('button.sessions-right-workbench-canvas-composer-mode')) as HTMLButtonElement;
			button.type = 'button';
			button.dataset.kind = kind;
			button.appendChild(renderIcon(kind === 'image' ? Codicon.fileMedia : Codicon.deviceCameraVideo));
			append(button, $('span', {}, kind === 'image' ? localize('rightWorkbench.canvas.modeImage', "Image") : localize('rightWorkbench.canvas.modeVideo', "Video")));
			this._register(addDisposableListener(button, EventType.CLICK, () => this.setComposerKind(kind)));
		}
		this.composerModel = append(footer, $('button.sessions-right-workbench-canvas-composer-model')) as HTMLButtonElement;
		this.composerModel.type = 'button';
		this.composerModel.setAttribute('aria-haspopup', 'listbox');
		this._register(addDisposableListener(this.composerModel, EventType.CLICK, () => this.toggleModelMenu()));
		// Video length: one chip with a menu; Auto (the default) leaves the length to the agent.
		this.composerLength = append(footer, $('button.sessions-right-workbench-canvas-composer-model.sessions-right-workbench-canvas-composer-length')) as HTMLButtonElement;
		this.composerLength.type = 'button';
		this.composerLength.title = localize('rightWorkbench.canvas.videoLength', "Video Length");
		this.composerLength.setAttribute('aria-haspopup', 'listbox');
		this._register(addDisposableListener(this.composerLength, EventType.CLICK, () => this.toggleLengthMenu()));
		this.composerSend = append(footer, $('button.sessions-right-workbench-canvas-composer-send')) as HTMLButtonElement;
		this.composerSend.type = 'submit';
		this.composerSend.ariaLabel = this.composerSend.title = localize('rightWorkbench.canvas.sendEdit', "Send");
		this.composerSend.appendChild(renderIcon(Codicon.arrowUp));
		this._register(addDisposableListener(this.composer, EventType.SUBMIT, event => {
			event.preventDefault();
			this.submitComposer();
		}));
		this._register(addDisposableListener(this.composerInput, EventType.KEY_DOWN, event => {
			if (!event.isComposing && this.handleMentionKey(event)) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				this.submitComposer();
			}
		}));
		this._register(addDisposableListener(this.composerInput, EventType.INPUT, () => {
			this.updateComposer();
			this.updateMentionMenu();
		}));
		this._register(addDisposableListener(this.composerInput, EventType.BLUR, () => this.mentionMenu.clear()));
		this.registerDropTarget();
		const resize = new (getWindow(container).ResizeObserver)(() => this.updateToolbarDensity());
		resize.observe(this.root);
		this._register(toDisposable(() => resize.disconnect()));
		// Escape steps back from an item to the grid before it closes Canvas.
		this._register(addDisposableListener(this.root, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && this.view === 'focused' && !event.defaultPrevented) {
				event.preventDefault();
				this.setView('canvas');
			}
		}));
		this.updateComposer();
	}

	setGroups(groups: readonly ICanvasImageGroup[], chatKey: string | undefined): void {
		if (this.chatKey !== undefined && chatKey !== this.chatKey) {
			this.selected.clear();
			this.comments.clear();
			this.draft = undefined;
			this.awaitingResult = undefined;
		}
		groups = this.withoutBroken(groups);
		const signature = groupsSignature(groups);
		if (chatKey === this.chatKey && signature === this.groupsSignature) {
			return; // Streaming refreshes that add nothing must not restart playing videos.
		}
		this.groupsSignature = signature;
		this.chatKey = chatKey;
		this.groups = groups;
		this.pruneState();
		// A requested edit landed: show the new item.
		if (this.awaitingResult) {
			const awaiting = this.awaitingResult;
			const fresh = groups.flatMap(group => group.images).filter(image => !awaiting.has(image.key)).pop();
			if (fresh) {
				this.awaitingResult = undefined;
				this.selected.clear();
				this.selected.add(fresh.key);
				if (this.references.length <= 1) {
					this.references = [fresh.key];
				}
				this.publishSelection();
			}
		}
		this.render();
	}

	/** Media from the user's other chats, shown after this chat's, labelled with their chat. */
	setOtherChatGroups(groups: readonly ICanvasImageGroup[]): void {
		const own = new Set(this.groups.flatMap(group => group.images.map(image => image.key)));
		const otherGroups = groups
			.map(group => ({ ...group, images: group.images.filter(image => !own.has(image.key) && !this.broken.has(image.key)) }))
			.filter(group => group.images.length > 0);
		if (groupsSignature(otherGroups) === groupsSignature(this.otherGroups)) {
			return;
		}
		this.otherGroups = otherGroups;
		this.pruneState();
		this.render();
	}

	/** Re-reads the chat's image/video model into the composer. */
	refreshMediaModels(): void {
		this.updateComposer();
		this.updateChatModel();
	}

	/** Shows the chat's language model on the thread header's chip. */
	private updateChatModel(): void {
		const chat = this.delegate.getChatModels?.();
		const current = chat?.models.find(model => model.id === chat.current);
		this.chatModelButton.hidden = !chat?.models.length;
		clearNode(this.chatModelButton);
		const label = current?.label ?? localize('rightWorkbench.canvas.chatModelAuto', "Auto");
		append(this.chatModelButton, $(`span.combined-model-logo.provider-${modelLogoKey(label)}`)).setAttribute('aria-hidden', 'true');
		append(this.chatModelButton, $('span.label', {}, label));
		this.chatModelButton.appendChild(renderIcon(Codicon.chevronDown));
	}

	/** The chat's language models, the current one checked; picking one switches the chat's model. */
	private toggleChatModelMenu(): void {
		this.toggleComposerMenu(this.chatModelButton, localize('rightWorkbench.canvas.chatModel', "Chat Model"), async () => {
			const chat = this.delegate.getChatModels?.();
			return chat?.models.map(model => ({
				label: model.label,
				logo: modelLogoKey(model.label),
				selected: model.id === chat.current,
				run: () => {
					this.delegate.setChatModel?.(model.id);
					this.updateChatModel();
				},
			}));
		}, localize('rightWorkbench.canvas.noChatModels', "No models available for this chat."), 'header');
	}

	private pruneState(): void {
		const keys = new Set(this.allImages.map(image => image.key));
		for (const key of [...this.selected]) {
			if (!keys.has(key)) {
				this.selected.delete(key);
			}
		}
		for (const key of [...this.comments.keys()]) {
			if (!keys.has(key)) {
				this.comments.delete(key);
			}
		}
	}

	/** Selects an image (e.g. one clicked in the chat) and shows it in the given view. */
	reveal(imageKey: string | undefined, view: CanvasView | undefined): void {
		if (imageKey && this.allImages.some(image => image.key === imageKey)) {
			this.selected.clear();
			this.selected.add(imageKey);
			if (view === 'focused') {
				this.references = [imageKey];
				this.freshChat = !!this.allImages.find(image => image.key === imageKey)?.uploaded;
			}
			this.publishSelection();
		}
		if (view) {
			this.view = view;
		}
		this.revealPending = true;
		this.render();
	}

	/**
	 * Selects exactly these items (e.g. what a side panel holds after one was
	 * removed there), without reporting the selection back to the delegate.
	 */
	setSelection(imageKeys: readonly string[]): void {
		const keys = new Set(this.allImages.map(image => image.key));
		const next = imageKeys.filter(key => keys.has(key));
		if (next.length === this.selected.size && next.every(key => this.selected.has(key))) {
			return;
		}
		this.selected.clear();
		for (const key of next) {
			this.selected.add(key);
		}
		this.render();
	}

	/** This chat's items first, then other chats' (display and navigation order). */
	private get allImages(): ICanvasImage[] {
		return [...this.groups, ...this.otherGroups].flatMap(group => group.images);
	}

	/** Turns the filter lets through, in its order (newest first by default). */
	private filterGroups(groups: readonly ICanvasImageGroup[]): ICanvasImageGroup[] {
		const { order, range, kind } = this.filter;
		const since = range === 'all' ? Number.NEGATIVE_INFINITY : Date.now() - RANGE_MS[range];
		return groups
			.filter(group => group.timestamp >= since)
			.map(group => kind === 'all' ? group : { ...group, images: group.images.filter(image => image.kind === kind) })
			.filter(group => group.images.length > 0)
			.sort((a, b) => order === 'newest' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp);
	}

	/** What the grid and filmstrip show: the filtered items, this chat's before other chats'. */
	private visibleImages(): ICanvasImage[] {
		return [...this.filterGroups(this.groups), ...this.filterGroups(this.otherGroups)].flatMap(group => group.images);
	}

	private get filterActive(): boolean {
		return this.filter.range !== 'all' || this.filter.kind !== 'all';
	}

	private setFilter(filter: ICanvasFilter): void {
		this.filter = filter;
		this.delegate.saveFilter?.(filter);
		this.revealPending = true;
		this.render();
	}

	private sourceOf(image: ICanvasImage): ICanvasSource | undefined {
		return this.otherGroups.find(group => group.images.includes(image))?.source;
	}

	private render(): void {
		// A re-render (e.g. media streaming in) must not drop keyboard focus from the shown item.
		const refocus = !!this.focusedStage && getWindow(this.root).document.activeElement === this.focusedStage;
		// The grid keeps its scroll position while media streams in; only a reveal or view change re-aims it.
		const gridScroll = this.revealPending ? undefined : this.body.querySelector<HTMLElement>('.sessions-right-workbench-canvas-scroll')?.scrollTop;
		this.revealPending = false;
		// Moving a playing video pauses it; resume the ones this render places again.
		const playing = [...this.mediaPool.values()].filter((element): element is HTMLVideoElement => element instanceof HTMLVideoElement && element.isConnected && !element.paused);
		this.renderStore.clear();
		clearNode(this.body);
		this.focusedStage = undefined;
		this.root.classList.toggle('focused', this.view === 'focused');
		this.root.classList.toggle('expanded', this.view === 'focused' && this.expanded);
		this.root.classList.toggle('comment-mode', this.commentMode);
		if (this.view === 'focused' && !this.expanded) {
			this.root.style.setProperty('--cd-side', `${this.sideWidth}px`);
		} else {
			this.root.style.removeProperty('--cd-side');
		}
		this.updateToolbarDensity();
		const showSide = this.view === 'focused' && !!this.allImages.length && !this.expanded;
		const sideShown = !this.side.hidden;
		this.side.hidden = !showSide;
		this.composer.hidden = !showSide;
		if (!this.allImages.length) {
			this.renderEmpty();
			return;
		}
		if (this.view === 'focused') {
			this.renderFocused();
			if (refocus) {
				this.focus();
			}
			if (!sideShown) {
				this.renderThread(true);
			}
		} else {
			this.renderGrid(gridScroll);
		}
		// Grid and asset view share one toolbar: view switch, Comment / Multi-Select, Upload, Filter, Zoom.
		this.renderToolbar();
		// Measure the rebuilt toolbar; the early call above only sized the stage.
		this.updateToolbarDensity();
		for (const video of playing) {
			if (video.isConnected) {
				void video.play().catch(() => { });
			}
		}
		this.prunePool(['tile', 'rail', 'focused']);
	}

	private renderEmpty(): void {
		const empty = append(this.body, $('.sessions-right-workbench-review-empty.sessions-right-workbench-canvas-empty'));
		empty.appendChild(renderIcon(Codicon.fileMedia));
		append(empty, $('h2', {}, localize('rightWorkbench.canvas.emptyTitle', "No Images Yet")));
		append(empty, $('p', {}, localize('rightWorkbench.canvas.emptyDescription', "Images and videos generated in this thread will appear here.")));
		const pickUploads = this.delegate.pickUploads;
		if (pickUploads) {
			append(empty, $('p', {}, localize('rightWorkbench.canvas.emptyUpload', "You can also upload your own, or drop them here.")));
			const upload = append(empty, $('button.sessions-right-workbench-canvas-pill-send', {}, localize('rightWorkbench.canvas.upload', "Upload"))) as HTMLButtonElement;
			upload.type = 'button';
			this.renderStore.add(addDisposableListener(upload, EventType.CLICK, () => void this.receiveUploads(pickUploads(), false)));
		}
	}

	// --- toolbar ------------------------------------------------------------

	private renderToolbar(): void {
		const views = append(this.body, $('.sessions-right-workbench-canvas-views'));
		views.setAttribute('role', 'group');
		views.ariaLabel = localize('rightWorkbench.canvas.views', "Image View");
		this.renderViewButton(views, 'focused', localize('rightWorkbench.canvas.focusedView', "Focused View"));
		this.renderViewButton(views, 'canvas', localize('rightWorkbench.canvas.canvasView', "Canvas View"));

		const anchor = append(this.body, $('.sessions-right-workbench-canvas-pill-anchor'));
		const pill = append(anchor, $('.sessions-right-workbench-canvas-pill'));
		pill.setAttribute('role', 'toolbar');
		pill.ariaLabel = localize('rightWorkbench.canvas.tools', "Image Playground Tools");
		if (this.commentMode) {
			this.renderCommentBanner(pill);
		} else if (this.multiSelect) {
			this.renderMultiSelectBanner(pill);
		} else {
			this.renderPillButton(pill, Codicon.commentAdd, localize('rightWorkbench.canvas.comment', "Comment"), undefined, () => this.setCommentMode(true));
			this.renderPillButton(pill, Codicon.selection, localize('rightWorkbench.canvas.multiSelect', "Multi-Select"), this.multiSelect, () => this.toggleMultiSelect());
		}

		const corner = append(this.body, $('.sessions-right-workbench-canvas-corner'));
		const pickUploads = this.delegate.pickUploads;
		if (pickUploads) {
			const upload = append(corner, $('button.sessions-right-workbench-canvas-filter.sessions-right-workbench-canvas-upload')) as HTMLButtonElement;
			upload.type = 'button';
			upload.title = localize('rightWorkbench.canvas.uploadTitle', "Upload images or videos (or drop them here)");
			upload.appendChild(renderIcon(Codicon.cloudUpload));
			append(upload, $('span.value', {}, localize('rightWorkbench.canvas.upload', "Upload")));
			this.renderStore.add(addDisposableListener(upload, EventType.CLICK, () => void this.receiveUploads(pickUploads(), this.view === 'focused')));
		}
		this.renderFilter(corner);
		this.renderZoom(corner);
	}

	/**
	 * Files dropped anywhere on Canvas are uploaded: in the grid they are
	 * picked out; in the asset view (and on its chat) they join the
	 * composer's references as the next @image_N.
	 */
	private registerDropTarget(): void {
		const hasFiles = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
		const hasItem = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes(CANVAS_ITEM_MIME);
		const overChat = (event: DragEvent) => this.view === 'focused' && !this.side.hidden && this.side.contains(event.target as Node);
		this._register(new DragAndDropObserver(this.root, {
			onDragEnter: event => {
				if (hasFiles(event) && this.delegate.uploadFiles) {
					this.root.classList.add('drop-target');
				}
			},
			onDragOver: event => {
				if (!event.dataTransfer) {
					return;
				}
				if (hasItem(event)) {
					// An item from the filmstrip or the chat: only the chat panel takes it, as a reference.
					const accept = overChat(event);
					event.dataTransfer.dropEffect = accept ? 'copy' : 'none';
					this.side.classList.toggle('drop-reference', accept);
				} else if (hasFiles(event)) {
					event.dataTransfer.dropEffect = this.delegate.uploadFiles ? 'copy' : 'none';
				}
			},
			onDragLeave: () => {
				this.root.classList.remove('drop-target');
				this.side.classList.remove('drop-reference');
			},
			onDragEnd: () => {
				this.root.classList.remove('drop-target', 'dragging-item');
				this.side.classList.remove('drop-reference');
			},
			onDrop: event => {
				this.root.classList.remove('drop-target', 'dragging-item');
				this.side.classList.remove('drop-reference');
				if (hasItem(event)) {
					event.preventDefault();
					event.stopPropagation();
					const key = event.dataTransfer?.getData(CANVAS_ITEM_MIME);
					const image = key ? this.allImages.find(item => item.key === key) : undefined;
					if (image && overChat(event)) {
						this.addReference(image);
						this.renderComposerAttachment();
						this.updateComposer();
						this.render();
						this.composerInput.focus();
					}
					return;
				}
				const files = [...event.dataTransfer?.files ?? []].filter(file => /^(?:image|video)\//.test(file.type));
				if (!hasFiles(event) || !this.delegate.uploadFiles) {
					return;
				}
				// Canvas takes the drop (the window must not open the files).
				event.preventDefault();
				event.stopPropagation();
				if (files.length) {
					void this.receiveUploads(this.delegate.uploadFiles(files), this.view === 'focused');
				}
			},
		}));
		append(this.root, $('.sessions-right-workbench-canvas-drop-hint', {}, localize('rightWorkbench.canvas.dropHint', "Drop images or videos to upload")));
	}

	/** Shows what was uploaded: as the next references in the asset view, or picked out in the grid. */
	private async receiveUploads(uploading: Promise<readonly ICanvasImage[]>, asReferences: boolean): Promise<void> {
		const uploaded = (await uploading).map(item => this.allImages.find(image => image.key === item.key)).filter(isDefined);
		if (!uploaded.length) {
			return;
		}
		if (asReferences) {
			uploaded.forEach(image => this.addReference(image));
			this.select(uploaded[0]);
			this.renderComposerAttachment();
			this.updateComposer();
			this.composerInput.focus();
			return;
		}
		this.selected.clear();
		uploaded.forEach(image => this.selected.add(image.key));
		this.publishSelection();
		this.revealPending = true;
		this.render();
	}

	/** The filter chip: recent-only, images or videos, and order, in one menu. */
	private renderFilter(container: HTMLElement): void {
		const button = append(container, $('button.sessions-right-workbench-canvas-filter')) as HTMLButtonElement;
		button.type = 'button';
		button.title = button.ariaLabel = localize('rightWorkbench.canvas.filter', "Filter");
		button.setAttribute('aria-haspopup', 'menu');
		button.classList.toggle('active', this.filterActive);
		button.appendChild(renderIcon(this.filterActive ? Codicon.filterFilled : Codicon.filter));
		const rangeLabels = {
			all: localize('rightWorkbench.canvas.rangeAll', "All Time"),
			day: localize('rightWorkbench.canvas.rangeDay', "Last 24 Hours"),
			week: localize('rightWorkbench.canvas.rangeWeek', "Last 7 Days"),
			month: localize('rightWorkbench.canvas.rangeMonth', "Last 30 Days"),
		};
		const kindLabels = {
			all: localize('rightWorkbench.canvas.kindAll', "Images and Videos"),
			image: localize('rightWorkbench.canvas.kindImages', "Images Only"),
			video: localize('rightWorkbench.canvas.kindVideos', "Videos Only"),
		};
		if (this.filterActive) {
			const parts = [this.filter.range !== 'all' ? rangeLabels[this.filter.range] : undefined, this.filter.kind !== 'all' ? kindLabels[this.filter.kind] : undefined].filter(isDefined);
			append(button, $('span.value', {}, parts.join(' · ')));
			// The label hides on a narrow stage; keep the active filter in the tooltip.
			button.title = button.ariaLabel = localize('rightWorkbench.canvas.filterActive', "Filter: {0}", parts.join(' · '));
		}
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => {
			const option = <K extends keyof ICanvasFilter>(key: K, value: ICanvasFilter[K], label: string) => toAction({
				id: `sessions.rightWorkbench.canvas.filter.${key}.${value}`,
				label,
				checked: this.filter[key] === value,
				run: () => this.setFilter({ ...this.filter, [key]: value }),
			});
			this.contextMenuService.showContextMenu({
				getAnchor: () => button,
				getActions: () => [
					option('order', 'newest', localize('rightWorkbench.canvas.newestFirst', "Newest First")),
					option('order', 'oldest', localize('rightWorkbench.canvas.oldestFirst', "Oldest First")),
					new Separator(),
					...(['all', 'day', 'week', 'month'] as const).map(range => option('range', range, rangeLabels[range])),
					new Separator(),
					...(['all', 'image', 'video'] as const).map(kind => option('kind', kind, kindLabels[kind])),
				],
			});
		}));
	}

	/** Shows the delegate's actions for `image` at `anchor` (an element or a pointer event). */
	private showItemActions(image: ICanvasImage, anchor: HTMLElement | StandardMouseEvent): boolean {
		const actions = this.delegate.getItemActions?.(image);
		if (!actions?.length) {
			return false;
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
		return true;
	}

	private registerItemContextMenu(element: HTMLElement, image: ICanvasImage): void {
		this.renderStore.add(addDisposableListener(element, EventType.CONTEXT_MENU, event => {
			if (this.showItemActions(image, new StandardMouseEvent(getWindow(element), event))) {
				event.preventDefault();
				event.stopPropagation();
			}
		}));
	}

	private renderViewButton(container: HTMLElement, view: CanvasView, label: string): void {
		const button = append(container, $('button.sessions-right-workbench-canvas-view-button')) as HTMLButtonElement;
		button.type = 'button';
		button.ariaLabel = button.title = label;
		button.setAttribute('aria-pressed', String(this.view === view));
		if (view === 'focused') {
			button.appendChild(renderIcon(Codicon.window));
		} else {
			// Codicons have no 2×2 grid; draw one so the two views read apart.
			const grid = append(button, $('span.sessions-right-workbench-canvas-grid-icon'));
			grid.setAttribute('aria-hidden', 'true');
			for (let i = 0; i < 4; i++) {
				append(grid, $('span'));
			}
		}
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => this.setView(view)));
	}

	private renderPillButton(container: HTMLElement, icon: ThemeIcon, label: string, pressed: boolean | undefined, run: () => void): void {
		const button = append(container, $('button.sessions-right-workbench-canvas-pill-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		if (pressed !== undefined) {
			button.setAttribute('aria-pressed', String(pressed));
		}
		button.appendChild(renderIcon(icon));
		append(button, $('span.label', {}, label));
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, run));
	}

	/** Multi-Select's pill: how many are picked, Edit (opens them together in the asset view), and exit. */
	private renderMultiSelectBanner(pill: HTMLElement): void {
		const count = this.selected.size;
		append(pill, $('span.sessions-right-workbench-canvas-pill-hint', {}, count === 0
			? localize('rightWorkbench.canvas.multiSelectHint', "Select images to edit together")
			: count === 1 ? localize('rightWorkbench.canvas.oneSelected', "1 selected") : localize('rightWorkbench.canvas.selectedCount', "{0} selected", count)));
		const edit = append(pill, $('button.sessions-right-workbench-canvas-pill-send', {}, localize('rightWorkbench.canvas.editTogether', "Edit"))) as HTMLButtonElement;
		edit.type = 'button';
		edit.disabled = count === 0;
		edit.title = localize('rightWorkbench.canvas.editTogetherTitle', "Open the selected images together, as @image_1, @image_2, …");
		this.renderStore.add(addDisposableListener(edit, EventType.CLICK, () => this.editSelected()));
		const close = append(pill, $('button.sessions-right-workbench-canvas-pill-close')) as HTMLButtonElement;
		close.type = 'button';
		close.ariaLabel = close.title = localize('rightWorkbench.canvas.exitMultiSelect', "Exit Multi-Select");
		close.appendChild(renderIcon(Codicon.close));
		this.renderStore.add(addDisposableListener(close, EventType.CLICK, () => this.toggleMultiSelect()));
	}

	/** Opens the Multi-Select picks in the asset view, as the composer's references in the order they were picked. */
	private editSelected(): void {
		const keys = [...this.selected].filter(key => this.allImages.some(image => image.key === key));
		if (!keys.length) {
			return;
		}
		this.references = keys;
		this.multiSelect = false;
		const first = this.allImages.find(image => image.key === keys[0])!;
		this.select(first);
		this.setView('focused');
		this.composerInput.focus();
	}

	private renderCommentBanner(pill: HTMLElement): void {
		const count = [...this.comments.values()].reduce((sum, list) => sum + list.length, 0);
		append(pill, $('span.sessions-right-workbench-canvas-pill-hint', {}, count === 0
			? localize('rightWorkbench.canvas.commentHint', "Add comments on multiple images to batch edit them")
			: count === 1 ? localize('rightWorkbench.canvas.oneComment', "1 comment") : localize('rightWorkbench.canvas.comments', "{0} comments", count)));
		const send = append(pill, $('button.sessions-right-workbench-canvas-pill-send', {}, localize('rightWorkbench.canvas.send', "Send"))) as HTMLButtonElement;
		send.type = 'button';
		send.disabled = count === 0;
		this.renderStore.add(addDisposableListener(send, EventType.CLICK, () => this.sendComments()));
		const close = append(pill, $('button.sessions-right-workbench-canvas-pill-close')) as HTMLButtonElement;
		close.type = 'button';
		close.ariaLabel = close.title = localize('rightWorkbench.canvas.exitComments', "Exit Comment Mode");
		close.appendChild(renderIcon(Codicon.close));
		this.renderStore.add(addDisposableListener(close, EventType.CLICK, () => this.setCommentMode(false)));
	}

	/** The zoom chip: grid scale, or in the asset view the item's scale (fitted by default). */
	private renderZoom(container: HTMLElement): void {
		const zoom = append(container, $('button.sessions-right-workbench-canvas-zoom')) as HTMLButtonElement;
		zoom.type = 'button';
		zoom.ariaLabel = localize('rightWorkbench.canvas.zoom', "Zoom");
		zoom.setAttribute('aria-haspopup', 'menu');
		const focused = this.view === 'focused';
		const current = focused ? this.focusedZoom : this.canvasZoom;
		append(zoom, $('span.value', {}, current === 'fit' ? localize('rightWorkbench.canvas.fit', "Fit") : `${Math.round(current * 100)}%`));
		zoom.appendChild(renderIcon(Codicon.chevronDown));
		this.renderStore.add(addDisposableListener(zoom, EventType.CLICK, () => {
			const levels: IAction[] = CANVAS_ZOOM_LEVELS.map(level => toAction({
				id: `sessions.rightWorkbench.canvas.zoom.${level}`,
				label: `${Math.round(level * 100)}%`,
				checked: level === current,
				run: () => this.setZoom(level),
			}));
			if (focused) {
				levels.push(new Separator(), toAction({
					id: 'sessions.rightWorkbench.canvas.zoom.fit',
					label: localize('rightWorkbench.canvas.zoomToFit', "Zoom to Fit"),
					checked: current === 'fit',
					run: () => this.setZoom('fit'),
				}));
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => zoom,
				getActions: () => levels,
			});
		}));
	}

	private setZoom(level: number | 'fit'): void {
		if (this.view === 'focused') {
			this.focusedZoom = level;
		} else if (level !== 'fit') {
			this.canvasZoom = level;
		}
		this.render();
	}

	private setView(view: CanvasView): void {
		if (this.view !== view) {
			this.view = view;
			this.revealPending = true;
			const current = view === 'focused' && !this.references.length ? this.currentItem() : undefined;
			if (current) {
				this.references = [current.key];
			}
			this.draft = undefined;
			this.expanded = false;
			this.render();
		}
	}

	private toggleMultiSelect(): void {
		const current = this.view === 'focused' ? this.currentItem() : undefined;
		this.multiSelect = !this.multiSelect;
		// Multi-Select starts from nothing picked (in the asset view, from the shown item); leaving it keeps just what's shown.
		this.selected.clear();
		if (current) {
			this.selected.add(current.key);
		}
		this.commentMode = false;
		this.publishSelection();
		this.render();
	}

	private setCommentMode(on: boolean): void {
		this.commentMode = on;
		if (on) {
			this.multiSelect = false;
		}
		this.draft = undefined;
		if (!on) {
			this.comments.clear();
		}
		this.render();
	}

	private sendComments(): void {
		const byImage = new Map<ICanvasImage, readonly ICanvasComment[]>();
		for (const image of this.allImages) {
			const list = this.comments.get(image.key);
			if (list?.length) {
				byImage.set(image, list);
			}
		}
		if (!byImage.size) {
			return;
		}
		this.delegate.sendComments(byImage);
		// Watch the edit in the asset view's chat, showing the first commented item.
		const [first] = byImage.keys();
		this.references = [...byImage.keys()].map(image => image.key);
		this.select(first);
		this.setView('focused');
		this.setCommentMode(false);
	}

	// --- canvas view --------------------------------------------------------

	private renderGrid(scrollTop: number | undefined): void {
		const scroll = append(this.body, $('.sessions-right-workbench-canvas-scroll'));
		const content = append(scroll, $('.sessions-right-workbench-canvas-content'));
		content.style.setProperty('--rwb-canvas-zoom', String(this.canvasZoom));
		let selectedFrame: HTMLElement | undefined;
		let lastRow: HTMLElement | undefined;
		const renderRows = (groups: readonly ICanvasImageGroup[]) => {
			for (const group of groups) {
				const row = append(content, $('.sessions-right-workbench-canvas-row'));
				const heading = append(row, $('.sessions-right-workbench-canvas-time'));
				if (group.source) {
					// Another chat's turn: its chat name leads, so it never reads as this chat's.
					append(heading, $('span.sessions-right-workbench-canvas-source', {}, group.source.title));
				}
				const time = append(heading, $('time', {}, timeFormatter.value.format(group.timestamp)));
				time.setAttribute('datetime', new Date(group.timestamp).toISOString());
				for (const image of group.images) {
					const frame = this.renderTile(row, image);
					if (this.selected.has(image.key) || this.draft?.key === image.key) {
						selectedFrame ??= frame;
					}
				}
				if (!group.source) {
					lastRow = row;
				}
			}
		};
		const groups = this.filterGroups(this.groups);
		const otherGroups = this.filterGroups(this.otherGroups);
		if (!groups.length && !otherGroups.length) {
			const empty = append(content, $('.sessions-right-workbench-canvas-filter-empty'));
			append(empty, $('p', {}, localize('rightWorkbench.canvas.filterEmpty', "Nothing matches this filter.")));
			const clear = append(empty, $('button.sessions-right-workbench-canvas-pill-send', {}, localize('rightWorkbench.canvas.clearFilter', "Show Everything"))) as HTMLButtonElement;
			clear.type = 'button';
			this.renderStore.add(addDisposableListener(clear, EventType.CLICK, () => this.setFilter({ ...this.filter, range: 'all', kind: 'all' })));
		}
		renderRows(groups);
		if (otherGroups.length) {
			append(content, $('h3.sessions-right-workbench-canvas-section', {}, localize('rightWorkbench.canvas.otherChats', "From Other Chats")));
			renderRows(otherGroups);
		}
		if (scrollTop !== undefined) {
			scroll.scrollTop = scrollTop;
		} else if (selectedFrame) {
			selectedFrame.scrollIntoView({ block: 'nearest' });
		} else if (this.filter.order === 'oldest') {
			// Oldest first puts the newest at the bottom: start there.
			lastRow?.scrollIntoView({ block: 'nearest' });
		}
	}

	private renderTile(container: HTMLElement, image: ICanvasImage): HTMLElement {
		const frame = append(container, $('.sessions-right-workbench-canvas-frame'));
		const tile = append(frame, $('button.sessions-right-workbench-canvas-tile')) as HTMLButtonElement;
		tile.type = 'button';
		const source = this.sourceOf(image);
		tile.ariaLabel = source ? localize('rightWorkbench.canvas.fromChat', "{0}, from {1}", image.label, source.title) : image.label;
		const hasComments = !!this.comments.get(image.key)?.length;
		// In comment mode the ring marks images carrying notes; otherwise it marks the selection.
		const ringed = this.commentMode ? hasComments || this.draft?.key === image.key : this.selected.has(image.key);
		tile.setAttribute('aria-pressed', String(ringed));
		this.renderMedia(tile, image, 'tile');
		if (this.multiSelect && !this.commentMode && this.selected.has(image.key)) {
			append(frame, $('span.sessions-right-workbench-canvas-check')).appendChild(renderIcon(Codicon.check));
		}
		this.renderPins(frame, image);
		this.registerItemContextMenu(tile, image);
		this.renderStore.add(addDisposableListener(tile, EventType.CLICK, event => {
			if (this.commentMode) {
				const rect = tile.getBoundingClientRect();
				this.draft = { key: image.key, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
				this.render();
			} else if (this.multiSelect) {
				this.toggleSelection(image);
			} else {
				// A click opens the item to look at and edit, like Runway's asset view, as the only reference.
				this.references = [];
				this.select(image);
				this.setView('focused');
				this.focusedStage?.focus();
			}
		}));
		return frame;
	}

	private renderPins(frame: HTMLElement, image: ICanvasImage): void {
		const list = this.comments.get(image.key) ?? [];
		const numberOffset = this.commentNumberOffset(image.key);
		list.forEach((comment, index) => {
			const pin = append(frame, $('span.sessions-right-workbench-canvas-pin', {}, String(numberOffset + index + 1)));
			pin.style.left = `${comment.x * 100}%`;
			pin.style.top = `${comment.y * 100}%`;
			pin.title = comment.text;
		});
		if (this.draft?.key !== image.key) {
			return;
		}
		const draft = this.draft;
		const pin = append(frame, $('span.sessions-right-workbench-canvas-pin', {}, String(numberOffset + list.length + 1)));
		pin.style.left = `${draft.x * 100}%`;
		pin.style.top = `${draft.y * 100}%`;
		const bubble = append(frame, $('form.sessions-right-workbench-canvas-comment'));
		bubble.style.left = `${draft.x * 100}%`;
		bubble.style.top = `${draft.y * 100}%`;
		// Past the middle the bubble opens to the pin's left so it stays over the image.
		bubble.classList.toggle('flip', draft.x > 0.55);
		const input = append(bubble, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('rightWorkbench.canvas.addComment', "Add a comment…");
		input.ariaLabel = input.placeholder;
		this.renderStore.add(addDisposableListener(bubble, EventType.SUBMIT, event => {
			event.preventDefault();
			const text = input.value.trim();
			if (text) {
				const comments = this.comments.get(draft.key) ?? [];
				comments.push({ x: draft.x, y: draft.y, text });
				this.comments.set(draft.key, comments);
			}
			this.draft = undefined;
			this.render();
		}));
		this.renderStore.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.draft = undefined;
				this.render();
			}
		}));
		this.renderStore.add(addDisposableListener(input, EventType.CLICK, event => event.stopPropagation()));
		const timeout = setTimeout(() => input.focus(), 0);
		this.renderStore.add({ dispose: () => clearTimeout(timeout) });
	}

	/** Comment numbers run across images in display order, like Codex. */
	private commentNumberOffset(imageKey: string): number {
		let offset = 0;
		for (const image of this.allImages) {
			if (image.key === imageKey) {
				break;
			}
			offset += this.comments.get(image.key)?.length ?? 0;
		}
		return offset;
	}

	// --- focused view -------------------------------------------------------

	/** The selected item, else the newest one the filter shows (else the newest of all). */
	private currentItem(): ICanvasImage | undefined {
		const images = this.allImages;
		const visible = this.visibleImages();
		return images.find(image => this.selected.has(image.key))
			?? (this.filter.order === 'newest' ? visible[0] : visible[visible.length - 1])
			?? images[images.length - 1];
	}

	private groupOf(image: ICanvasImage): ICanvasImageGroup | undefined {
		return [...this.groups, ...this.otherGroups].find(group => group.images.includes(image));
	}

	/**
	 * Runway's asset view: tabs over the item fitted large, its name and quick
	 * actions on it, the filmstrip floating at its side, and the action row
	 * under it. The chat beside it lives in {@link side}.
	 */
	private renderFocused(): void {
		const current = this.currentItem()!;
		// The filmstrip (and arrow keys) follow the filter; the shown item stays in it even when filtered out.
		const visible = this.visibleImages();
		const images = visible.includes(current) ? visible : [current, ...visible];
		const group = this.groupOf(current);
		const featured = append(this.body, $('.sessions-right-workbench-canvas-featured'));
		const stage = append(featured, $('.sessions-right-workbench-canvas-focused-stage'));
		stage.tabIndex = 0;
		const source = this.sourceOf(current);
		stage.ariaLabel = source ? localize('rightWorkbench.canvas.fromChat', "{0}, from {1}", current.label, source.title) : current.label;
		this.focusedStage = stage;
		const box = append(stage, $('.sessions-right-workbench-canvas-featured-box'));
		const media = this.renderMedia(box, current, 'focused');
		this.fitToStage(stage, box, media);
		this.registerItemContextMenu(stage, current);
		// Comment mode pins numbered notes on the shown item, as on grid tiles.
		box.classList.toggle('commenting', this.commentMode);
		this.renderPins(box, current);
		this.renderStore.add(addDisposableListener(box, EventType.CLICK, event => {
			if (!this.commentMode || (event.target as HTMLElement).closest('button, input, form')) {
				return;
			}
			const rect = box.getBoundingClientRect();
			this.draft = { key: current.key, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
			this.render();
		}));
		const reference = this.references.indexOf(current.key);
		append(box, $('span.sessions-right-workbench-canvas-featured-name', {}, reference >= 0 && this.references.length > 1 ? `@${referenceName(reference)} · ${current.label}` : current.label));
		const badges = append(box, $('.sessions-right-workbench-canvas-featured-badges'));
		const saveAs = this.delegate.saveAs;
		if (saveAs) {
			this.renderIconButton(badges, Codicon.desktopDownload, localize('rightWorkbench.canvas.download', "Download"), () => saveAs(current));
		}
		this.renderIconButton(badges, this.expanded ? Codicon.screenNormal : Codicon.screenFull,
			this.expanded ? localize('rightWorkbench.canvas.showChat', "Show Chat") : localize('rightWorkbench.canvas.expand', "Expand"),
			() => {
				this.expanded = !this.expanded;
				this.render();
				this.focusedStage?.focus();
			});
		if (media instanceof HTMLVideoElement) {
			const length = append(this.body, $('.sessions-right-workbench-canvas-length-chip'));
			length.appendChild(renderIcon(Codicon.deviceCameraVideo));
			this.showVideoLength(media, append(length, $('span')));
		}
		if (source) {
			const badge = append(this.body, $('.sessions-right-workbench-canvas-source-badge'));
			badge.appendChild(renderIcon(Codicon.commentDiscussion));
			append(badge, $('span', {}, localize('rightWorkbench.canvas.fromOtherChat', "From another chat: {0}", source.title)));
		}
		const index = images.indexOf(current);
		this.renderStore.add(addDisposableListener(stage, EventType.KEY_DOWN, event => {
			const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
			if (step && images.length > 1) {
				event.preventDefault();
				this.select(images[(index + step + images.length) % images.length]);
			}
		}));
		this.renderRail(images, current);
		this.renderDetailActions(current, group);
		this.renderComposerAttachment();
		this.updateComposer();
	}

	/** Sizes the item's box to the largest fit inside the stage, so its name and badges sit on its corners. */
	private fitToStage(stage: HTMLElement, box: HTMLElement, media: HTMLImageElement | HTMLVideoElement): void {
		const fit = () => {
			// No preview: a 16:9 card as wide as the stage allows.
			const placeholder = box.classList.contains('no-preview');
			const width = placeholder ? 16 : media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
			const height = placeholder ? 9 : media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
			if (!width || !height || !stage.clientWidth || !stage.clientHeight) {
				return;
			}
			const scale = placeholder ? Math.min(Math.min(stage.clientWidth, 720) / width, stage.clientHeight / height) : this.focusedZoom === 'fit' ? Math.min(stage.clientWidth / width, stage.clientHeight / height) : this.focusedZoom;
			stage.classList.toggle('zoomed', this.focusedZoom !== 'fit');
			box.style.width = `${Math.floor(width * scale)}px`;
			box.style.height = `${Math.floor(height * scale)}px`;
			box.classList.add('fitted');
		};
		this.renderStore.add(addDisposableListener(media, media instanceof HTMLVideoElement ? 'loadedmetadata' : 'load', fit));
		const observer = new ResizeObserver(fit);
		observer.observe(stage);
		this.renderStore.add(toDisposable(() => observer.disconnect()));
		fit();
	}

	/** Runway's row under the asset: file actions, then prompt actions. */
	private renderDetailActions(current: ICanvasImage, group: ICanvasImageGroup | undefined): void {
		const row = append(this.body, $('.sessions-right-workbench-canvas-detail-actions'));
		const saveAs = this.delegate.saveAs;
		if (saveAs) {
			this.renderIconButton(row, Codicon.desktopDownload, localize('rightWorkbench.canvas.download', "Download"), () => saveAs(current));
		}
		const revealInOS = this.delegate.revealInOS;
		if (current.localFile && revealInOS) {
			const label = isMacintosh ? localize('rightWorkbench.canvas.revealMac', "Reveal in Finder") : isWindows ? localize('rightWorkbench.canvas.revealWindows', "Reveal in File Explorer") : localize('rightWorkbench.canvas.revealLinux', "Open Containing Folder");
			this.renderIconButton(row, Codicon.folderOpened, label, () => revealInOS(current));
		}
		if (this.delegate.getItemActions?.(current).length) {
			const more = this.renderIconButton(row, Codicon.ellipsis, localize('rightWorkbench.canvas.moreActions', "More Actions"), () => this.showItemActions(current, more));
			more.setAttribute('aria-haspopup', 'menu');
		}
		append(row, $('span.sessions-right-workbench-canvas-detail-divider'));
		const prompt = group?.prompt;
		if (prompt) {
			this.renderIconButton(row, Codicon.copy, localize('rightWorkbench.canvas.copyPrompt', "Copy Prompt"), () => void this.clipboardService.writeText(prompt));
			this.renderLabelButton(row, Codicon.refresh, localize('rightWorkbench.canvas.prompt', "Prompt"), localize('rightWorkbench.canvas.reusePrompt', "Reuse Prompt"), () => {
				this.composerInput.value = prompt;
				this.updateComposer();
				this.composerInput.focus();
			});
		}
		// Runway's "Chat": put the item into the chat's composer to talk about it.
		this.renderLabelButton(row, Codicon.add, localize('rightWorkbench.canvas.chatLabel', "Chat"), localize('rightWorkbench.canvas.addToChat', "Add to Chat"), () => {
			this.expanded = false;
			this.addReference(current);
			this.render();
			this.composerInput.focus();
		});
	}

	// --- thread -------------------------------------------------------------

	/** Moves focus back into Canvas: the shown item, or the grid. */
	focus(): void {
		(this.focusedStage ?? this.root.querySelector<HTMLElement>('button'))?.focus();
	}

	/** The chat beside the focused item, kept live as it streams. */
	setThread(thread: ICanvasThread | undefined): void {
		this.thread = thread;
		this.renderThread(false);
	}

	private threadKey(): string {
		const current = this.currentItem()?.key ?? '';
		return `${this.freshChat}|${this.thread?.title}|${current}|${this.thread?.turns.map(turn => `${turn.id}:${turn.prompt.length}:${turn.reply.length}:${turn.media.length}:${turn.inProgress}:${turn.question?.resolveId ?? (turn.question ? 'q' : '')}:${turn.generating ?? ''}`).join(',')}`;
	}

	/**
	 * Renders the thread: each message with its attachments, the agent's
	 * answer, the media it made (click one to show it), and a working row
	 * while it runs. Follows the bottom unless the user scrolled up.
	 */
	private renderThread(force: boolean): void {
		if (this.side.hidden) {
			return;
		}
		const key = this.threadKey();
		if (!force && key === this.threadSignature) {
			return;
		}
		const turnCountChanged = this.threadSignature?.split(',').length !== key.split(',').length;
		this.threadSignature = key;
		const scroll = this.threadScroll;
		const atBottom = force || turnCountChanged || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
		const previousTop = scroll.scrollTop;
		this.threadStore.clear();
		clearNode(scroll);
		this.threadTitle.textContent = this.freshChat ? localize('rightWorkbench.canvas.newChat', "New chat") : this.thread?.title || localize('rightWorkbench.canvas.chat', "Chat");
		const current = this.currentItem();
		// An upload starts with an empty chat of its own; the first message creates it.
		const turns = this.freshChat ? [] : this.thread?.turns ?? [];
		if (!turns.length) {
			append(scroll, $('p.sessions-right-workbench-canvas-thread-empty', {}, localize('rightWorkbench.canvas.threadEmpty', "Ask for an image or video, or describe an edit to the one shown.")));
		}
		for (const turn of turns) {
			const message = append(scroll, $('.sessions-right-workbench-canvas-message'));
			if (turn.attachments.length) {
				const list = append(message, $('.sessions-right-workbench-canvas-message-attachments'));
				turn.attachments.forEach((attachment, index) => this.renderAttachment(list, attachment, `${turn.id}:${index}`));
			}
			if (turn.prompt) {
				this.renderUserBubble(message, turn.prompt);
			}
			if (turn.reply) {
				const answer = append(message, $('.sessions-right-workbench-canvas-message-answer'));
				const rendered = this.threadStore.add(renderMarkdown(new MarkdownString(turn.reply), {
					actionHandler: href => this.delegate.openLink?.(href),
				}));
				answer.appendChild(rendered.element);
			}
			const media = turn.media.filter(item => !this.broken.has(item.key));
			if (media.length) {
				const grid = append(message, $('.sessions-right-workbench-canvas-message-media'));
				grid.classList.toggle('single', media.length === 1);
				for (const item of media) {
					const tile = append(grid, $('button.sessions-right-workbench-canvas-message-tile')) as HTMLButtonElement;
					tile.type = 'button';
					tile.title = tile.ariaLabel = item.label;
					tile.setAttribute('aria-pressed', String(item.key === current?.key));
					this.renderMedia(tile, item, 'thumb', this.threadStore, 'thread');
					const shownItem = this.allImages.find(image => image.key === item.key);
					if (shownItem) {
						this.makeDraggable(tile, shownItem, this.threadStore);
					}
					this.threadStore.add(addDisposableListener(tile, EventType.CLICK, () => {
						const shown = this.allImages.find(image => image.key === item.key);
						if (shown) {
							this.select(shown);
						}
					}));
				}
			}
			if (turn.question) {
				this.renderQuestion(message, turn.question);
			} else if (turn.generating) {
				// The chat's own "Generating image/video…" dot-field card.
				renderGeneratedImagePlaceholder(append(message, $('.sessions-right-workbench-canvas-message-generating')), turn.generating);
			} else if (turn.inProgress) {
				// The chat's cadenced "Thinking" shimmer, not a spinner row.
				const working = append(message, applyCodexRoot(cxEl('div', 'text-size-chat text-secondary sessions-right-workbench-canvas-message-working')));
				working.appendChild(this.threadStore.add(new CodexCadencedShimmer(localize('rightWorkbench.canvas.thinking', "Thinking"))).element);
			}
		}
		scroll.scrollTop = atBottom ? scroll.scrollHeight : previousTop;
		this.prunePool(['thread']);
	}

	/**
	 * A question the agent is waiting on, answered in place: each option is a
	 * button; picking one settles the chat's question exactly as its own card
	 * would, and the turn continues.
	 */
	private renderQuestion(container: HTMLElement, carousel: ChatQuestionCarouselData): void {
		const card = append(container, $('.sessions-right-workbench-canvas-question'));
		for (const question of carousel.questions) {
			append(card, $('.sessions-right-workbench-canvas-question-title', {}, question.title));
			const options = append(card, $('.sessions-right-workbench-canvas-question-options'));
			for (const option of question.options ?? []) {
				const button = append(options, $('button.sessions-right-workbench-canvas-question-option', {}, option.label)) as HTMLButtonElement;
				button.type = 'button';
				this.threadStore.add(addDisposableListener(button, EventType.CLICK, () => {
					const answer = question.type === 'multiSelect' ? { selectedValues: [option.value] } : { selectedValue: option.value };
					carousel.dismiss({ [question.id]: answer });
					this.renderThread(true);
				}));
			}
			if (!question.options?.length) {
				append(card, $('p.sessions-right-workbench-canvas-question-hint', {}, localize('rightWorkbench.canvas.questionInChat', "Answer this in the chat.")));
			}
		}
		if (carousel.allowSkip) {
			const skip = append(card, $('button.sessions-right-workbench-canvas-question-skip', {}, localize('rightWorkbench.canvas.questionSkip', "Skip"))) as HTMLButtonElement;
			skip.type = 'button';
			this.threadStore.add(addDisposableListener(skip, EventType.CLICK, () => {
				carousel.dismiss(undefined);
				this.renderThread(true);
			}));
		}
	}

	private renderUserBubble(container: HTMLElement, prompt: string): void {
		const bubble = append(container, $('.sessions-right-workbench-canvas-message-user'));
		const text = append(bubble, $('.sessions-right-workbench-canvas-message-user-text', {}, prompt));
		const toggle = append(bubble, $('button.sessions-right-workbench-canvas-message-more', {}, localize('rightWorkbench.canvas.showMore', "Show more"))) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.hidden = true;
		// Long prompts clamp like Runway's; the toggle appears once the text has laid out.
		const handle = setTimeout(() => toggle.hidden = text.scrollHeight <= text.clientHeight + 1, 0);
		this.threadStore.add(toDisposable(() => clearTimeout(handle)));
		this.threadStore.add(addDisposableListener(toggle, EventType.CLICK, () => {
			const open = bubble.classList.toggle('open');
			toggle.textContent = open ? localize('rightWorkbench.canvas.showLess', "Show less") : localize('rightWorkbench.canvas.showMore', "Show more");
		}));
	}

	private renderAttachment(container: HTMLElement, attachment: ICanvasAttachment, key: string): void {
		const tile = append(container, $('.sessions-right-workbench-canvas-message-attachment'));
		const slot = append(tile, $('.sessions-right-workbench-canvas-message-attachment-thumb'));
		append(tile, $('span.sessions-right-workbench-canvas-message-attachment-caption', {}, attachment.label));
		const img = append(slot, $('img')) as HTMLImageElement;
		img.alt = '';
		img.draggable = false;
		if (attachment.data) {
			let url = this.attachmentUrls.get(key);
			if (!url) {
				url = URL.createObjectURL(new Blob([attachment.data.slice()], { type: attachment.mimeType ?? 'image/png' }));
				this.attachmentUrls.set(key, url);
			}
			img.src = url;
		} else if (attachment.uri) {
			this.loadInto(img, { key: attachment.uri.toString(), src: attachment.uri, label: attachment.label, kind: 'image', localFile: attachment.uri.scheme === 'file' ? attachment.uri : undefined }, 'thumb', this.threadStore, false);
		}
	}

	/** Lets an item be dragged onto the chat panel, where it becomes the composer's next @image reference. */
	private makeDraggable(element: HTMLElement, image: ICanvasImage, store: DisposableStore): void {
		element.draggable = true;
		store.add(addDisposableListener(element, EventType.DRAG_START, (event: DragEvent) => {
			if (!event.dataTransfer) {
				return;
			}
			event.dataTransfer.setData(CANVAS_ITEM_MIME, image.key);
			event.dataTransfer.effectAllowed = 'copy';
			const media = element.querySelector<HTMLElement>('img, video');
			if (media) {
				event.dataTransfer.setDragImage(media, 24, 24);
			}
			this.root.classList.add('dragging-item');
		}));
		store.add(addDisposableListener(element, EventType.DRAG_END, () => this.root.classList.remove('dragging-item')));
	}

	private renderIconButton(container: HTMLElement, icon: ThemeIcon, label: string, run: () => void): HTMLButtonElement {
		const button = append(container, $('button.sessions-right-workbench-canvas-detail-icon')) as HTMLButtonElement;
		button.type = 'button';
		button.title = button.ariaLabel = label;
		button.appendChild(renderIcon(icon));
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	private renderLabelButton(container: HTMLElement, icon: ThemeIcon, label: string, title: string, run: () => void): HTMLButtonElement {
		const button = append(container, $('button.sessions-right-workbench-canvas-detail-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = title;
		button.appendChild(renderIcon(icon));
		append(button, $('span', {}, label));
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	/** Every item as a vertical filmstrip beside the focused view; other chats' come last, under a label. */
	private renderRail(images: readonly ICanvasImage[], current: ICanvasImage): void {
		const rail = append(this.body, $('.sessions-right-workbench-canvas-rail'));
		rail.setAttribute('role', 'group');
		rail.ariaLabel = localize('rightWorkbench.canvas.allMedia', "All Images and Videos");
		let labelledOther = false;
		let currentThumb: HTMLElement | undefined;
		for (const image of images) {
			const source = this.sourceOf(image);
			if (source && !labelledOther) {
				labelledOther = true;
				append(rail, $('.sessions-right-workbench-canvas-rail-label', {}, localize('rightWorkbench.canvas.otherChatsShort', "Other Chats")));
			}
			const thumb = append(rail, $('button.sessions-right-workbench-canvas-rail-thumb')) as HTMLButtonElement;
			thumb.type = 'button';
			thumb.title = thumb.ariaLabel = source ? localize('rightWorkbench.canvas.fromChat', "{0}, from {1}", image.label, source.title) : image.label;
			thumb.setAttribute('aria-pressed', String(image === current));
			thumb.classList.toggle('other-chat', !!source);
			const reference = this.references.indexOf(image.key);
			if (reference >= 0 && this.references.length > 1) {
				append(thumb, $('span.sessions-right-workbench-canvas-reference-badge', {}, String(reference + 1)));
			}
			this.renderMedia(thumb, image, 'thumb', this.renderStore, 'rail');
			if (image === current) {
				currentThumb = thumb;
			}
			this.registerItemContextMenu(thumb, image);
			if (this.multiSelect && this.selected.has(image.key)) {
				append(thumb, $('span.sessions-right-workbench-canvas-check')).appendChild(renderIcon(Codicon.check));
			}
			this.makeDraggable(thumb, image, this.renderStore);
			this.renderStore.add(addDisposableListener(thumb, EventType.CLICK, () => this.multiSelect ? this.toggleSelection(image) : this.select(image)));
		}
		const handle = setTimeout(() => currentThumb?.scrollIntoView({ block: 'nearest' }), 0);
		this.renderStore.add({ dispose: () => clearTimeout(handle) });
	}

	private select(image: ICanvasImage): void {
		this.freshChat = !!image.uploaded;
		this.selected.clear();
		this.selected.add(image.key);
		// One reference follows the shown item; a Multi-Select set stays while you look through the filmstrip.
		if (this.references.length <= 1) {
			this.references = [image.key];
		}
		this.publishSelection();
		// The thread beside an item is the chat it came from.
		const source = this.groupOf(image)?.source;
		if (source) {
			this.delegate.focusSourceChat?.(source);
		}
		this.render();
		this.renderThread(false);
		// The clicked thumb or tile was re-rendered; keep keyboard focus in the view.
		this.focusedStage?.focus();
	}

	/**
	 * An image or video for a grid tile, filmstrip thumb, or the focused stage.
	 * Videos preview muted and play on hover; the focused one plays with controls.
	 * Elements are kept per `slot` and item across renders, so a re-render
	 * moves the loaded element instead of reloading it (which flashed).
	 */
	private renderMedia(container: HTMLElement, image: ICanvasImage, role: 'tile' | 'thumb' | 'focused', store: DisposableStore = this.renderStore, slot: string = role): HTMLImageElement | HTMLVideoElement {
		const poolKey = `${slot}\n${image.key}`;
		const pooled = this.mediaPool.get(poolKey);
		const element = pooled && !pooled.isConnected ? pooled : this.createMedia(image, role);
		this.mediaPool.set(poolKey, element);
		container.appendChild(element);
		if (this.unpreviewable.has(image.key)) {
			// Kept (it can still be a reference), shown as a labelled placeholder.
			element.removeAttribute('src');
			container.classList.add('no-preview');
			const placeholder = append(container, $('span.sessions-right-workbench-canvas-no-preview'));
			placeholder.appendChild(renderIcon(image.kind === 'video' ? Codicon.deviceCameraVideo : Codicon.fileMedia));
			if (role !== 'thumb') {
				append(placeholder, $('span', {}, localize('rightWorkbench.canvas.noPreview', "No preview")));
			}
			return element;
		}
		if (element instanceof HTMLVideoElement && role !== 'focused') {
			const badge = append(container, $('span.sessions-right-workbench-canvas-video-badge'));
			badge.appendChild(renderIcon(Codicon.play));
			this.showVideoLength(element, append(badge, $('span.length')), store);
			store.add(addDisposableListener(container, EventType.MOUSE_ENTER, () => void element.play().catch(() => { })));
			store.add(addDisposableListener(container, EventType.MOUSE_LEAVE, () => element.pause()));
		}
		this.loadInto(element, image, role, store);
		return element;
	}

	private createMedia(image: ICanvasImage, role: 'tile' | 'thumb' | 'focused'): HTMLImageElement | HTMLVideoElement {
		if (image.kind === 'video') {
			const video = $('video') as HTMLVideoElement;
			video.muted = true;
			video.loop = true;
			video.playsInline = true;
			video.preload = 'metadata';
			if (role === 'focused') {
				video.controls = true;
				video.autoplay = true;
			}
			return video;
		}
		const img = $('img') as HTMLImageElement;
		img.alt = role === 'focused' ? image.label : '';
		img.decoding = 'async';
		img.draggable = false;
		img.referrerPolicy = 'no-referrer';
		return img;
	}

	/** A video's length in whole seconds, once any of its elements has loaded its metadata. */
	private knownVideoLength(image: ICanvasImage): number | undefined {
		for (const [key, element] of this.mediaPool) {
			if (key.endsWith(`\n${image.key}`) && element instanceof HTMLVideoElement && isFinite(element.duration) && element.duration > 0) {
				return Math.max(1, Math.round(element.duration));
			}
		}
		return undefined;
	}

	/** Forgets kept media of these slots that the last render no longer placed. */
	private prunePool(slots: readonly string[]): void {
		for (const [key, element] of this.mediaPool) {
			if (!element.isConnected && slots.includes(key.slice(0, key.indexOf('\n')))) {
				this.mediaPool.delete(key);
			}
		}
	}

	/** Fills `target` with the video's length once its metadata is known. */
	private showVideoLength(video: HTMLVideoElement, target: HTMLElement, store: DisposableStore = this.renderStore): void {
		const update = () => {
			const text = formatVideoLength(video.duration);
			target.textContent = text ?? '';
			target.parentElement?.classList.toggle('has-length', !!text);
			if (text) {
				target.parentElement?.setAttribute('aria-label', localize('rightWorkbench.canvas.videoLengthLabel', "Video, {0}", text));
			}
		};
		update();
		store.add(addDisposableListener(video, 'loadedmetadata', update));
		store.add(addDisposableListener(video, 'durationchange', update));
	}

	// --- composer -------------------------------------------------------------

	private setComposerKind(kind: CanvasMediaKind): void {
		this.composerMenu.clear();
		this.composerKind = kind;
		this.updateComposer();
		this.composerInput.focus();
	}

	/** Beside a wide chat the stage is narrow: the toolbar drops its labels (icons keep their tooltips). */
	/**
	 * Keeps the top toolbar from overlapping as the stage narrows (window
	 * resize or chat sash): labels drop first in both views, then the centered
	 * Comment/Multi-Select pill hides if it would still collide with the view
	 * switch or the corner controls. Collision is measured, not guessed.
	 */
	private updateToolbarDensity(): void {
		const hasSide = this.view === 'focused' && !this.expanded;
		// The chat panel keeps its saved width only while the stage keeps a
		// usable minimum; on a narrow window it gives way first (down to its own
		// minimum) instead of crushing the stage and its toolbar.
		const sideWidth = hasSide
			? Math.max(MIN_SIDE_WIDTH, Math.min(this.sideWidth, this.root.clientWidth - MIN_STAGE_WIDTH))
			: 0;
		if (hasSide) {
			this.root.style.setProperty('--cd-side', `${sideWidth}px`);
		}
		const stageWidth = this.root.clientWidth - sideWidth;
		this.root.classList.remove('crowded-toolbar');
		this.root.classList.toggle('compact-toolbar', stageWidth < 640);
		// Escalate only as far as needed: drop labels, then step the pill aside.
		if (this.toolbarPillCollides() && !this.root.classList.contains('compact-toolbar')) {
			this.root.classList.add('compact-toolbar');
		}
		this.root.classList.toggle('crowded-toolbar', this.toolbarPillCollides());
	}

	/** Whether the centered pill touches the view switch or the corner controls. */
	private toolbarPillCollides(): boolean {
		const pillRect = this.root.querySelector<HTMLElement>('.sessions-right-workbench-canvas-pill')?.getBoundingClientRect();
		if (!pillRect?.width) {
			return false;
		}
		return [...this.root.querySelectorAll<HTMLElement>('.sessions-right-workbench-canvas-views, .sessions-right-workbench-canvas-corner')]
			.map(element => element.getBoundingClientRect())
			.some(rect => rect.width > 0 && rect.left < pillRect.right + 8 && rect.right > pillRect.left - 8);
	}

	/** Drag the chat panel's left edge to resize it (as Runway's); double-click restores the default. */
	private registerSideSash(sash: HTMLElement): void {
		sash.setAttribute('role', 'separator');
		sash.setAttribute('aria-orientation', 'vertical');
		sash.title = localize('rightWorkbench.canvas.resizeChat', "Drag to resize, double-click to reset");
		const apply = (width: number) => {
			this.sideWidth = width;
			this.root.style.setProperty('--cd-side', `${width}px`);
			this.updateToolbarDensity();
		};
		this._register(addDisposableListener(sash, EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			sash.setPointerCapture(event.pointerId);
			this.root.classList.add('resizing-side');
			const right = this.root.getBoundingClientRect().right;
			const gesture = new DisposableStore();
			gesture.add(addDisposableListener(sash, EventType.POINTER_MOVE, (move: PointerEvent) => {
				// Leave the stage at least 360px.
				apply(clampSideWidth(Math.min(right - move.clientX, this.root.clientWidth - 360)));
			}));
			const end = () => {
				gesture.dispose();
				this.root.classList.remove('resizing-side');
				this.delegate.saveSideWidth?.(this.sideWidth);
			};
			gesture.add(addDisposableListener(sash, EventType.POINTER_UP, end));
			gesture.add(addDisposableListener(sash, 'pointercancel', end));
		}));
		this._register(addDisposableListener(sash, EventType.DBLCLICK, () => {
			apply(DEFAULT_SIDE_WIDTH);
			this.delegate.saveSideWidth?.(this.sideWidth);
		}));
	}

	/** The composer's model menu (Runway's model picker): the chat's models for the chosen kind, the current one checked. */
	private toggleModelMenu(): void {
		const kind = this.composerKind;
		this.toggleComposerMenu(this.composerModel,
			kind === 'video' ? localize('rightWorkbench.canvas.videoModel', "Video Model") : localize('rightWorkbench.canvas.imageModel', "Image Model"),
			async () => {
				const choices = await this.delegate.getModelChoices?.(kind);
				return choices?.values.map((value, index) => ({
					label: choices.labels[index] || value,
					logo: modelLogoKey(`${value} ${choices.labels[index] ?? ''}`),
					selected: value === choices.current,
					run: () => this.delegate.setModel?.(kind, value),
				}));
			},
			localize('rightWorkbench.canvas.noModels', "No models available for this chat."));
	}

	private toggleLengthMenu(): void {
		this.toggleComposerMenu(this.composerLength, localize('rightWorkbench.canvas.videoLength', "Video Length"), async () => [
			{ label: localize('rightWorkbench.canvas.lengthAuto', "Auto"), selected: this.composerSeconds === undefined, run: () => this.composerSeconds = undefined },
			...VIDEO_LENGTH_SECONDS.map(seconds => ({
				label: localize('rightWorkbench.canvas.seconds', "{0}s", seconds),
				selected: this.composerSeconds === seconds,
				run: () => this.composerSeconds = seconds,
			})),
		], '');
	}

	/**
	 * A compact single-line menu above the composer, anchored to one of its
	 * chips; picking a row runs it. Closes on a press outside or Escape.
	 */
	private toggleComposerMenu(anchor: HTMLButtonElement, title: string, load: () => Promise<readonly { readonly label: string; readonly logo?: string; readonly selected: boolean; run(): void }[] | undefined>, emptyText: string, placement: 'composer' | 'header' = 'composer'): void {
		const wasOpen = this.composerMenuAnchor === anchor && !!this.composerMenu.value;
		this.composerMenu.clear();
		if (wasOpen) {
			return;
		}
		const store = new DisposableStore();
		this.composerMenu.value = store;
		this.composerMenuAnchor = anchor;
		store.add(toDisposable(() => this.composerMenuAnchor = undefined));
		// Above the composer for its chips; below the thread header for the chat model.
		const menu = append(placement === 'header' ? this.side : this.composer, $('.sessions-right-workbench-canvas-model-menu'));
		menu.classList.toggle('from-header', placement === 'header');
		store.add(toDisposable(() => menu.remove()));
		anchor.setAttribute('aria-expanded', 'true');
		store.add(toDisposable(() => anchor.setAttribute('aria-expanded', 'false')));
		append(menu, $('.sessions-right-workbench-canvas-model-menu-title', {}, title));
		const list = append(menu, $('.sessions-right-workbench-canvas-model-menu-list'));
		list.setAttribute('role', 'listbox');
		list.ariaLabel = title;
		const status = append(list, $('.sessions-right-workbench-canvas-model-menu-status', {}, localize('rightWorkbench.canvas.loadingModels', "Loading…")));
		const options = () => [...list.querySelectorAll<HTMLElement>('.sessions-right-workbench-canvas-model-option')];
		load().then(items => {
			if (store.isDisposed) {
				return;
			}
			if (!items?.length) {
				status.textContent = emptyText;
				return;
			}
			status.remove();
			for (const item of items) {
				const option = append(list, $('button.sessions-right-workbench-canvas-model-option')) as HTMLButtonElement;
				option.type = 'button';
				option.setAttribute('role', 'option');
				option.setAttribute('aria-selected', String(item.selected));
				if (item.logo) {
					append(option, $(`span.combined-model-logo.provider-${item.logo}`)).setAttribute('aria-hidden', 'true');
				}
				append(option, $('span.name', {}, item.label));
				if (item.selected) {
					option.appendChild(renderIcon(Codicon.check));
				}
				store.add(addDisposableListener(option, EventType.CLICK, () => {
					item.run();
					this.composerMenu.clear();
					this.updateComposer();
					this.composerInput.focus();
				}));
			}
			(list.querySelector<HTMLElement>('[aria-selected="true"]') ?? options()[0])?.focus();
		}, () => {
			if (!store.isDisposed) {
				status.textContent = localize('rightWorkbench.canvas.menuFailed', "Couldn't load. Try again.");
			}
		});
		store.add(addDisposableListener(getWindow(this.root).document, EventType.MOUSE_DOWN, event => {
			const target = event.target as Node;
			if (!menu.contains(target) && !anchor.contains(target)) {
				this.composerMenu.clear();
			}
		}, true));
		store.add(addDisposableListener(menu, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.composerMenu.clear();
				anchor.focus();
			} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const all = options();
				const index = all.indexOf(getWindow(this.root).document.activeElement as HTMLElement);
				all[(index + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
			}
		}));
	}

	/** The composer's references in `@image_N` order (items that disappeared are skipped). */
	private referencedImages(): ICanvasImage[] {
		const images = this.allImages;
		return this.references.map(key => images.find(image => image.key === key)).filter(isDefined);
	}

	private addReference(image: ICanvasImage): void {
		if (!this.references.includes(image.key)) {
			this.references = [...this.references, image.key];
		}
	}

	/**
	 * The reference slots, numbered `@image_1`, `@image_2`, … with a remove
	 * button each, and a slot that adds the shown item when it isn't one.
	 */
	private renderComposerAttachment(): void {
		this.composerStore.clear();
		clearNode(this.composerAttachments);
		const current = this.currentItem();
		const references = this.referencedImages();
		references.forEach((image, index) => {
			const slot = append(this.composerAttachments, $('.sessions-right-workbench-canvas-composer-slot'));
			slot.title = image.label;
			slot.classList.toggle('shown', image === current);
			this.renderMedia(slot, image, 'thumb', this.composerStore, 'composer');
			append(slot, $('span.sessions-right-workbench-canvas-composer-slot-name', {}, `@${referenceName(index)}`));
			const remove = append(slot, $('button.sessions-right-workbench-canvas-composer-slot-remove')) as HTMLButtonElement;
			remove.type = 'button';
			remove.title = remove.ariaLabel = localize('rightWorkbench.canvas.detach', "Remove {0}", `@${referenceName(index)}`);
			remove.appendChild(renderIcon(Codicon.close));
			this.composerStore.add(addDisposableListener(remove, EventType.CLICK, () => {
				this.references = this.references.filter(key => key !== image.key);
				this.renderComposerAttachment();
				this.updateComposer();
				this.render();
				this.composerInput.focus();
			}));
			// Clicking a reference shows it on the stage.
			this.composerStore.add(addDisposableListener(slot, EventType.CLICK, event => {
				if (!remove.contains(event.target as Node) && image !== this.currentItem()) {
					this.select(image);
				}
			}));
		});
		if (current && !references.includes(current)) {
			const attach = append(this.composerAttachments, $('button.sessions-right-workbench-canvas-composer-slot.empty')) as HTMLButtonElement;
			attach.type = 'button';
			attach.title = attach.ariaLabel = localize('rightWorkbench.canvas.attachShown', "Attach {0}", current.label);
			attach.appendChild(renderIcon(Codicon.add));
			this.composerStore.add(addDisposableListener(attach, EventType.CLICK, () => {
				this.addReference(current);
				this.renderComposerAttachment();
				this.updateComposer();
				this.render();
				this.composerInput.focus();
			}));
		}
		this.prunePool(['composer']);
	}

	// --- @ mentions -----------------------------------------------------------

	/** The `@…` being typed right before the caret, if any. */
	private mentionQuery(): { readonly start: number; readonly query: string } | undefined {
		const caret = this.composerInput.selectionStart ?? 0;
		const match = /(?:^|\s)@(\w*)$/.exec(this.composerInput.value.slice(0, caret));
		return match ? { start: caret - match[1].length - 1, query: match[1].toLowerCase() } : undefined;
	}

	/** Shows (or hides) the `@image_N` suggestions for the mention being typed. */
	private updateMentionMenu(): void {
		const mention = this.mentionQuery();
		const references = this.referencedImages();
		const matches = mention ? references.map((image, index) => ({ image, name: referenceName(index) })).filter(({ name }) => name.startsWith(mention.query) || name.replace('_', '').startsWith(mention.query)) : [];
		if (!mention || !matches.length) {
			this.mentionMenu.clear();
			return;
		}
		this.mentionIndex = Math.min(this.mentionIndex, matches.length - 1);
		const store = new DisposableStore();
		this.mentionMenu.value = store;
		const menu = append(this.composer, $('.sessions-right-workbench-canvas-model-menu.sessions-right-workbench-canvas-mention-menu'));
		store.add(toDisposable(() => menu.remove()));
		const list = append(menu, $('.sessions-right-workbench-canvas-model-menu-list'));
		list.setAttribute('role', 'listbox');
		list.ariaLabel = localize('rightWorkbench.canvas.mentions', "Images");
		matches.forEach(({ image, name }, index) => {
			const option = append(list, $('button.sessions-right-workbench-canvas-model-option.sessions-right-workbench-canvas-mention-option')) as HTMLButtonElement;
			option.type = 'button';
			option.tabIndex = -1;
			option.setAttribute('role', 'option');
			option.setAttribute('aria-selected', String(index === this.mentionIndex));
			const thumb = append(option, $('span.sessions-right-workbench-canvas-mention-thumb'));
			this.renderMedia(thumb, image, 'thumb', store, 'mention');
			append(option, $('span.name', {}, `@${name}`));
			append(option, $('span.sessions-right-workbench-canvas-mention-label', {}, image.label));
			// Keep the caret in the textarea: insert on press, before focus moves.
			store.add(addDisposableListener(option, EventType.MOUSE_DOWN, event => {
				event.preventDefault();
				this.insertMention(name);
			}));
		});
	}

	private insertMention(name: string): void {
		const mention = this.mentionQuery();
		if (!mention) {
			return;
		}
		const input = this.composerInput;
		const caret = input.selectionStart ?? input.value.length;
		const text = `@${name} `;
		input.value = input.value.slice(0, mention.start) + text + input.value.slice(caret);
		input.selectionStart = input.selectionEnd = mention.start + text.length;
		this.mentionMenu.clear();
		this.mentionIndex = 0;
		this.updateComposer();
		input.focus();
	}

	/** Arrow keys, Enter/Tab and Escape drive the `@` suggestions while they show. */
	private handleMentionKey(event: KeyboardEvent): boolean {
		if (!this.mentionMenu.value) {
			return false;
		}
		const options = [...this.composer.querySelectorAll<HTMLElement>('.sessions-right-workbench-canvas-mention-option')];
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			this.mentionIndex = (this.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
			this.updateMentionMenu();
			return true;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			const name = options[this.mentionIndex]?.querySelector('.name')?.textContent?.slice(1);
			if (name) {
				this.insertMention(name);
			}
			return true;
		}
		if (event.key === 'Escape') {
			this.mentionMenu.clear();
			return true;
		}
		return false;
	}

	private updateComposer(): void {
		const references = this.referencedImages();
		const attached = references[0];
		for (const button of this.composerModes.children) {
			button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.kind === this.composerKind));
		}
		// Generation choices apply to the attached item; a plain message leaves them to the agent.
		this.composerModes.hidden = !attached;
		this.composerLength.hidden = !attached || this.composerKind !== 'video';
		clearNode(this.composerLength);
		this.composerLength.appendChild(renderIcon(Codicon.clock));
		append(this.composerLength, $('span.label', {}, this.composerSeconds ? localize('rightWorkbench.canvas.seconds', "{0}s", this.composerSeconds) : localize('rightWorkbench.canvas.lengthAuto', "Auto")));
		this.composerLength.appendChild(renderIcon(Codicon.chevronDown));
		const model = this.delegate.getMediaModel(this.composerKind);
		this.composerModel.hidden = !model || !attached;
		this.composerModel.classList.toggle('inactive', !model?.active);
		clearNode(this.composerModel);
		if (model?.active && model.label) {
			append(this.composerModel, $(`span.combined-model-logo.provider-${modelLogoKey(model.label)}`)).setAttribute('aria-hidden', 'true');
		}
		append(this.composerModel, $('span.label', {}, model?.active && model.label ? model.label : localize('rightWorkbench.canvas.chooseModel', "Choose Model")));
		this.composerModel.appendChild(renderIcon(Codicon.chevronDown));
		this.composerModel.title = this.composerKind === 'video'
			? localize('rightWorkbench.canvas.videoModel', "Video Model")
			: localize('rightWorkbench.canvas.imageModel', "Image Model");
		const fromVideo = attached?.kind === 'video';
		this.composerInput.placeholder = !attached
			? localize('rightWorkbench.canvas.sendMessage', "Send a message…")
			: references.length > 1
				? localize('rightWorkbench.canvas.editMany', "Describe the edit — type @ to point at an image…")
				: this.composerKind === 'video'
				? fromVideo ? localize('rightWorkbench.canvas.editVideo', "Describe how to change this video…") : localize('rightWorkbench.canvas.videoFromImage', "Describe a video made from this image…")
				: fromVideo ? localize('rightWorkbench.canvas.imageFromVideo', "Describe an image based on this video…") : localize('rightWorkbench.canvas.editImage', "Describe an edit to this image…");
		this.composerInput.ariaLabel = this.composerInput.placeholder;
		this.composerSend.disabled = !this.composerInput.value.trim() || (!attached && !this.delegate.sendMessage);
		// Grow with the prompt, up to a third of the panel in the focused view.
		const maxHeight = this.view === 'focused' ? Math.max(120, Math.round(this.side.clientHeight / 3)) : 120;
		this.composerInput.style.height = 'auto';
		this.composerInput.style.height = `${Math.min(this.composerInput.scrollHeight, maxHeight)}px`;
	}

	private submitComposer(): void {
		const prompt = this.composerInput.value.trim();
		const references = this.referencedImages();
		if (!prompt || (!references.length && !this.delegate.sendMessage)) {
			return;
		}
		this.mentionMenu.clear();
		// The result arrives in this chat; show it once it does.
		this.awaitingResult = new Set(this.groups.flatMap(group => group.images.map(image => image.key)));
		const options: ICanvasSendOptions = { newChat: this.freshChat };
		// From here the thread follows the new chat.
		this.freshChat = false;
		if (references.length) {
			// Auto on a video edit keeps the source clip's length.
			const seconds = this.composerKind !== 'video' ? undefined : this.composerSeconds ?? (references[0].kind === 'video' ? this.knownVideoLength(references[0]) : undefined);
			this.delegate.sendEdit(references, prompt, this.composerKind, seconds, options);
			// A length applies to one request; the next goes back to Auto.
			this.composerSeconds = undefined;
		} else {
			this.delegate.sendMessage?.(prompt, options);
		}
		this.composerInput.value = '';
		this.updateComposer();
	}

	// --- selection ----------------------------------------------------------

	private toggleSelection(image: ICanvasImage): void {
		if (this.multiSelect) {
			if (!this.selected.delete(image.key)) {
				this.selected.add(image.key);
			}
		} else if (this.selected.has(image.key) && this.selected.size === 1) {
			return; // Codex keeps a lone selection when it is clicked again.
		} else {
			this.selected.clear();
			this.selected.add(image.key);
		}
		this.publishSelection();
		this.render();
	}

	private publishSelection(): void {
		this.delegate.setComposerImages(this.allImages.filter(image => this.selected.has(image.key)));
	}

	/**
	 * Points `element` at the item's display URL: at once on the stage, and
	 * for tiles and thumbs once they scroll near view. An item whose media
	 * cannot be shown is dropped (unless `reportBroken` is off, e.g. for a
	 * message attachment).
	 */
	private loadInto(element: HTMLImageElement | HTMLVideoElement, image: ICanvasImage, role: 'tile' | 'thumb' | 'focused', store: DisposableStore, reportBroken = true): void {
		const size: CanvasMediaSize = role === 'focused' ? 'full' : 'thumb';
		const cacheKey = `${size}:${image.key}`;
		if (reportBroken) {
			store.add(addDisposableListener(element, 'error', () => this.markBroken(image.key)));
		}
		if (element.getAttribute('src')) {
			return; // A kept element already shows it.
		}
		const known = this.resolvedUrls.get(cacheKey);
		if (known) {
			element.src = known;
			return;
		}
		const load = async () => {
			let url = this.displayUrls.get(cacheKey);
			if (!url) {
				url = this.delegate.toDisplayUrl(image, size);
				this.displayUrls.set(cacheKey, url);
			}
			const resolved = await url;
			if (resolved) {
				this.resolvedUrls.set(cacheKey, resolved);
			}
			if (!element.isConnected) {
				return;
			}
			if (resolved) {
				element.src = resolved;
			} else if (reportBroken) {
				// No URL means the media is gone (e.g. an upload deleted from disk).
				this.markBroken(image.key, true);
			}
		};
		if (role === 'focused') {
			void load();
			return;
		}
		this.lazyLoads.set(element, () => void load());
		this.lazyObserver.observe(element);
		store.add(toDisposable(() => {
			this.lazyLoads.delete(element);
			this.lazyObserver.unobserve(element);
		}));
	}

	/**
	 * Drops an item whose media cannot be shown. An upload that exists but
	 * cannot be decoded keeps a "No preview" tile; a missing file is dropped.
	 */
	private markBroken(key: string, missing = false): void {
		const uploaded = this.allImages.find(image => image.key === key)?.uploaded;
		const set = uploaded && !missing ? this.unpreviewable : this.broken;
		if (!set.has(key)) {
			set.add(key);
			this.brokenScheduler.schedule();
		}
	}

	private withoutBroken(groups: readonly ICanvasImageGroup[]): readonly ICanvasImageGroup[] {
		if (!this.broken.size) {
			return groups;
		}
		return groups
			.map(group => group.images.some(image => this.broken.has(image.key)) ? { ...group, images: group.images.filter(image => !this.broken.has(image.key)) } : group)
			.filter(group => group.images.length > 0);
	}

	private dropBroken(): void {
		this.groups = this.withoutBroken(this.groups);
		this.otherGroups = this.withoutBroken(this.otherGroups);
		this.groupsSignature = groupsSignature(this.groups);
		this.pruneState();
		this.render();
		this.renderThread(true);
	}

}

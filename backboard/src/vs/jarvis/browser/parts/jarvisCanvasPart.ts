/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/jarvisCanvas.css';
import { getZoomFactor } from '../../../base/browser/browser.js';
import { $, addDisposableListener, append, EventHelper, EventType, getWindow, getWindowId } from '../../../base/browser/dom.js';
import { ProgressBar } from '../../../base/browser/ui/progressbar/progressbar.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { autorun, constObservable } from '../../../base/common/observable.js';
import { FileAccess } from '../../../base/common/network.js';
import { basename } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { defaultProgressBarStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { Part } from '../../../workbench/browser/part.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../workbench/contrib/browserView/common/browserView.js';
import { IChatService } from '../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ITerminalInstance, ITerminalService } from '../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { AbstractProgressScope, ScopedProgressIndicator } from '../../../workbench/services/progress/browser/progressIndicator.js';
import { SessionView } from '../../../sessions/browser/parts/sessionView.js';
import { IActiveSession, ISessionsManagementService } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { ISession, SessionStatus } from '../../../sessions/services/sessions/common/session.js';
import { ISessionsService } from '../../../sessions/services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../sessions/services/sessions/browser/sessionsProvidersService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../sessions/common/agentHostSessionsProvider.js';
import { SessionType } from '../../../workbench/contrib/chat/common/chatSessionsService.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground } from '../../../sessions/common/theme.js';
import { IJarvisCamera, IJarvisRect } from '../../common/jarvisCanvasTypes.js';
import { JarvisCard } from './jarvisCard.js';

const JARVIS_CANVAS_STORAGE_KEY = 'jarvis.canvas.state.v1';
const JARVIS_BACKGROUND_STORAGE_KEY = 'jarvis.canvas.background';

type JarvisCardKind = 'agent' | 'terminal' | 'browser' | 'file';
type JarvisBackground = 'fuji' | 'sky-island' | 'cloud-drift' | 'aurora';

interface IJarvisStoredState {
	readonly camera?: IJarvisCamera;
	readonly cards?: Readonly<Record<string, IJarvisRect>>;
}

interface IJarvisCardEntry {
	readonly card: JarvisCard;
	readonly kind: JarvisCardKind;
	readonly store: DisposableStore;
}

interface IJarvisPointerOperation {
	readonly pointerId: number;
	readonly kind: 'pan' | 'move' | 'resize';
	readonly startClientX: number;
	readonly startClientY: number;
	readonly startCamera: IJarvisCamera;
	readonly card?: JarvisCard;
	readonly startGeometry?: IJarvisRect;
}

const BACKGROUNDS: readonly JarvisBackground[] = ['fuji', 'sky-island', 'cloud-drift', 'aurora'];

function nextBackground(current: JarvisBackground): JarvisBackground {
	const index = BACKGROUNDS.indexOf(current);
	return BACKGROUNDS[(index + 1) % BACKGROUNDS.length];
}

function normalizeUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return 'https://example.com';
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
		return trimmed;
	}
	if (trimmed.includes('.') && !trimmed.includes(' ')) {
		return `https://${trimmed}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function compactChatText(value: string, maxLength = 1800): string {
	const text = value
		.replace(/```[\s\S]*?```/g, block => block.replace(/^```\w*\n?|\n?```$/g, ''))
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/[*_~]{1,3}/g, '')
		.trim();
	return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

function friendlyModelLabel(modelId: string | undefined, providerId: string | undefined, sessionType?: string): string {
	const source = modelId?.split('/').at(-1) || sessionType || providerId || 'Backboard';
	if (source === LOCAL_AGENT_HOST_PROVIDER_ID || source === 'local-agent-host') {
		return 'Backboard';
	}
	return source
		.replace(/^agent-host-/, '')
		.replace(/[-_]+/g, ' ')
		.replace(/\b\w/g, value => value.toUpperCase());
}

class JarvisTerminalCard extends JarvisCard {

	private instance: ITerminalInstance | undefined;
	private pendingDimension: { width: number; height: number } | undefined;

	constructor(
		id: string,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super(id, localize('jarvis.terminal.title', "Terminal"));
		this.contentElement.classList.add('jarvis-terminal-card-content');
		void this.createTerminal();
	}

	private async createTerminal(): Promise<void> {
		const instance = await this.terminalService.createTerminal({
			config: { name: localize('jarvis.terminal.name', "Jarvis Terminal") }
		});
		if (this._store.isDisposed) {
			instance.dispose();
			return;
		}
		this.instance = instance;
		instance.attachToElement(this.contentElement);
		instance.setVisible(true);
		if (this.pendingDimension) {
			instance.layout(this.pendingDimension);
		}
	}

	override focus(): void {
		this.instance?.focus();
	}

	protected override layoutContent(width: number, height: number): void {
		this.pendingDimension = { width, height };
		this.instance?.layout(this.pendingDimension);
	}

	override dispose(): void {
		this.instance?.dispose();
		super.dispose();
	}
}

class JarvisBrowserCard extends JarvisCard {

	private readonly toolbar: HTMLElement;
	private readonly addressInput: HTMLInputElement;
	private readonly browserSurface: HTMLElement;
	private readonly model = this._register(new MutableDisposable<IBrowserViewModel>());
	private pendingLayout = false;
	private surfaceVisible = true;

	constructor(
		id: string,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
	) {
		super(id, localize('jarvis.browser.title', "Browser"));
		this.contentElement.classList.add('jarvis-browser-card-content');

		this.toolbar = append(this.contentElement, $('.jarvis-browser-toolbar'));
		this.addToolbarButton('codicon-arrow-left', localize('jarvis.browser.back', "Back"), () => this.model.value?.goBack());
		this.addToolbarButton('codicon-arrow-right', localize('jarvis.browser.forward', "Forward"), () => this.model.value?.goForward());
		this.addToolbarButton('codicon-refresh', localize('jarvis.browser.reload', "Reload"), () => this.model.value?.reload());
		this.addressInput = append(this.toolbar, $('input.jarvis-browser-address')) as HTMLInputElement;
		this.addressInput.type = 'text';
		this.addressInput.value = 'https://example.com';
		this.addressInput.setAttribute('aria-label', localize('jarvis.browser.address', "Browser address"));
		this.addressInput.placeholder = localize('jarvis.browser.placeholder', "Search or enter address");
		const shareButton = this.addToolbarButton('codicon-broadcast', localize('jarvis.browser.share', "Share with agent"), async () => {
			const model = this.model.value;
			if (model) {
				await model.setSharedWithAgent(model.sharingState !== BrowserViewSharingState.Shared);
				shareButton.classList.toggle('active', model.sharingState === BrowserViewSharingState.Shared);
			}
		});
		this.browserSurface = append(this.contentElement, $('.jarvis-browser-surface'));

		this._register(addDisposableListener(this.addressInput, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter') {
				EventHelper.stop(event, true);
				void this.navigate(this.addressInput.value);
			}
		}));

		void this.createBrowser();
	}

	private addToolbarButton(icon: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
		const button = append(this.toolbar, $(`button.jarvis-browser-button.codicon.${icon}`)) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		this._register(addDisposableListener(button, EventType.CLICK, () => void run()));
		return button;
	}

	private async createBrowser(): Promise<void> {
		const input = this.browserViewWorkbenchService.getOrCreateLazy(`jarvis-${this.id}`, {
			url: this.addressInput.value,
			title: localize('jarvis.browser.title', "Browser")
		});
		const model = await input.resolve();
		if (this._store.isDisposed) {
			await model.setVisible(false);
			return;
		}
		this.model.value = model;
		this._register(model.onDidNavigate(event => {
			this.addressInput.value = event.url;
			this.setTitle(model.title || localize('jarvis.browser.title', "Browser"));
		}));
		this._register(model.onDidChangeTitle(() => this.setTitle(model.title || localize('jarvis.browser.title', "Browser"))));
		await model.setVisible(this.surfaceVisible);
		await this.navigate(this.addressInput.value);
		if (this.surfaceVisible) {
			this.layoutNativeBrowser();
		}
	}

	private async navigate(value: string): Promise<void> {
		const url = normalizeUrl(value);
		this.addressInput.value = url;
		await this.model.value?.loadURL(url, { source: 'urlInput' });
	}

	private layoutNativeBrowser(): void {
		// JarvisCard applies its initial geometry from the base constructor,
		// before this subclass's field initializers have run.
		if (!this.surfaceVisible || !this.model?.value || this.pendingLayout) {
			return;
		}
		this.pendingLayout = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.pendingLayout = false;
			const model = this.model.value;
			if (!model || !this.element.isConnected) {
				return;
			}
			const rect = this.browserSurface.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) {
				return;
			}
			void model.layout({
				windowId: getWindowId(getWindow(this.element)),
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
				zoomFactor: getZoomFactor(getWindow(this.element)),
				cornerRadius: 18
			});
		});
	}

	setSurfaceVisible(visible: boolean): void {
		this.surfaceVisible = visible;
		const model = this.model.value;
		if (!model) {
			return;
		}
		void model.setVisible(visible);
		if (visible) {
			this.layoutNativeBrowser();
		}
	}

	protected override layoutContent(_width: number, _height: number): void {
		this.layoutNativeBrowser();
	}

	override dispose(): void {
		void this.model.value?.setVisible(false);
		this.model.clear();
		super.dispose();
	}
}

class JarvisFileCard extends JarvisCard {

	private readonly emptyState: HTMLElement;
	private readonly preview: HTMLElement;
	private readonly pathLabel: HTMLElement;
	private resource: URI | undefined;

	constructor(
		id: string,
		@ICommandService private readonly commandService: ICommandService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(id, localize('jarvis.file.title', "File"));
		this.contentElement.classList.add('jarvis-file-card-content');

		const toolbar = append(this.contentElement, $('.jarvis-file-toolbar'));
		this.pathLabel = append(toolbar, $('.jarvis-file-path'));
		this.pathLabel.textContent = localize('jarvis.file.noFile', "No file selected");
		const reveal = append(toolbar, $('button.jarvis-file-toolbar-button.codicon.codicon-go-to-file')) as HTMLButtonElement;
		reveal.type = 'button';
		reveal.title = localize('jarvis.file.reveal', "Open in editor");
		this._register(addDisposableListener(reveal, EventType.CLICK, () => {
			if (this.resource) {
				void this.commandService.executeCommand('vscode.open', this.resource);
			}
		}));

		this.emptyState = append(this.contentElement, $('.jarvis-file-empty'));
		append(this.emptyState, $('.jarvis-file-card-icon.codicon.codicon-file-code'));
		append(this.emptyState, $('.jarvis-file-card-heading')).textContent = localize('jarvis.file.heading', "Open a working file");
		append(this.emptyState, $('.jarvis-file-card-copy')).textContent = localize('jarvis.file.copy', "Inspect source directly on the canvas without leaving your room.");
		const button = append(this.emptyState, $('button.jarvis-file-card-button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = localize('jarvis.file.open', "Choose File");
		this._register(addDisposableListener(button, EventType.CLICK, () => void this.chooseFile()));

		this.preview = append(this.contentElement, $('pre.jarvis-file-preview'));
		this.preview.hidden = true;
	}

	protected override layoutContent(_width: number, _height: number): void {
		// CSS owns the empty-state layout.
	}

	private async chooseFile(): Promise<void> {
		const defaultUri = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		const resources = await this.fileDialogService.showOpenDialog({
			title: localize('jarvis.file.dialogTitle', "Open file on Jarvis canvas"),
			defaultUri,
			openLabel: localize('jarvis.file.dialogOpen', "Open on Canvas"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false
		});
		const resource = resources?.[0];
		if (!resource) {
			return;
		}
		this.resource = resource;
		this.setTitle(basename(resource));
		this.pathLabel.textContent = resource.fsPath;
		try {
			const content = await this.fileService.readFile(resource, { length: 512 * 1024 });
			const value = content.value.toString();
			this.preview.textContent = value.includes('\0')
				? localize('jarvis.file.binary', "Binary file preview is not available. Open it in the editor from the arrow above.")
				: value;
		} catch (error) {
			this.preview.textContent = localize('jarvis.file.readError', "Could not read this file: {0}", String(error));
		}
		this.emptyState.hidden = true;
		this.preview.hidden = false;
	}
}

class JarvisAgentCard extends JarvisCard {

	readonly sessionView: SessionView;
	private readonly transcript: HTMLElement;
	private readonly statusElement: HTMLElement;
	private readonly modelElement: HTMLElement;
	private readonly composer: HTMLTextAreaElement;
	private readonly submitButton: HTMLButtonElement;
	private readonly sessionBindings = this._register(new DisposableStore());
	private readonly modelBinding = this._register(new MutableDisposable());
	private boundModelResource: string | undefined;
	private optimisticQuery: string | undefined;
	private submitting = false;
	private hasBoundSession = false;

	constructor(
		id: string,
		private session: IActiveSession | undefined,
		private readonly submit: (session: IActiveSession | undefined, query: string) => Promise<IActiveSession | undefined>,
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatService private readonly chatService: IChatService,
	) {
		super(id, session?.title.get() || localize('jarvis.agent.untitled', "New Agent"));
		this.contentElement.classList.add('jarvis-agent-card-content');

		const surface = append(this.contentElement, $('.jarvis-agent-surface'));
		const meta = append(this.headerElement, $('.jarvis-agent-meta'));
		this.headerElement.insertBefore(meta, this.headerElement.querySelector('.jarvis-card-close'));
		this.statusElement = append(meta, $('.jarvis-agent-status'));
		append(meta, $('.jarvis-agent-card-actions.codicon.codicon-info'));

		this.transcript = append(surface, $('.jarvis-agent-transcript'));

		const composerShell = append(surface, $('.jarvis-agent-composer'));
		this.composer = append(composerShell, $('textarea.jarvis-agent-composer-input')) as HTMLTextAreaElement;
		this.composer.rows = 2;
		this.composer.placeholder = localize('jarvis.agent.composer.placeholder', "Send a message");
		this.composer.setAttribute('aria-label', this.composer.placeholder);

		const composerFooter = append(composerShell, $('.jarvis-agent-composer-footer'));
		const modelGroup = append(composerFooter, $('.jarvis-agent-model-group'));
		append(modelGroup, $('.jarvis-agent-model-mark')).textContent = '✦';
		this.modelElement = append(modelGroup, $('.jarvis-agent-model-label'));
		const addButton = append(modelGroup, $('button.jarvis-agent-utility.codicon.codicon-add')) as HTMLButtonElement;
		addButton.type = 'button';
		addButton.title = localize('jarvis.agent.addContext', "Add context");
		const imageButton = append(modelGroup, $('button.jarvis-agent-utility.codicon.codicon-file-media')) as HTMLButtonElement;
		imageButton.type = 'button';
		imageButton.title = localize('jarvis.agent.addImage', "Add image");

		const actions = append(composerFooter, $('.jarvis-agent-composer-actions'));
		const micButton = append(actions, $('button.jarvis-agent-round-action.codicon.codicon-mic')) as HTMLButtonElement;
		micButton.type = 'button';
		micButton.title = localize('jarvis.agent.voice', "Voice input");
		const settingsButton = append(actions, $('button.jarvis-agent-utility.codicon.codicon-settings')) as HTMLButtonElement;
		settingsButton.type = 'button';
		settingsButton.title = localize('jarvis.agent.settings', "Agent controls");
		this.submitButton = append(actions, $('button.jarvis-agent-submit.codicon.codicon-arrow-up')) as HTMLButtonElement;
		this.submitButton.type = 'button';
		this.submitButton.title = localize('jarvis.agent.send', "Send message");

		this._register(addDisposableListener(this.submitButton, EventType.CLICK, () => void this.send()));
		this._register(addDisposableListener(this.composer, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' && !event.shiftKey) {
				EventHelper.stop(event, true);
				void this.send();
			}
		}));
		this._register(this.chatService.onDidCreateModel(model => {
			if (model.sessionResource.toString() === this.session?.activeChat.get().resource.toString()) {
				this.bindChatModel();
				this.render();
			}
		}));

		// Kept off-screen solely for workbench extension points that still
		// target SessionView (attachments, workspace selection and title edit).
		// Jarvis owns every visible pixel of the agent experience.
		this.sessionView = this._register(instantiationService.createInstance(SessionView));
		this.sessionView.element.classList.add('jarvis-agent-backend-view');
		this.contentElement.appendChild(this.sessionView.element);
		this.bind(session, false);
	}

	bind(session: IActiveSession | undefined, active: boolean): void {
		if (this.session === session && this.hasBoundSession) {
			this.sessionView.setActive(active);
			this.element.classList.toggle('active', active);
			return;
		}
		this.hasBoundSession = true;
		this.session = session;
		this.sessionBindings.clear();
		this.modelBinding.clear();
		this.boundModelResource = undefined;
		this.setTitle(session?.title.get() || localize('jarvis.agent.untitled', "New Agent"));
		this.sessionView.openSession(session, { renderSessionTypePickerInControls: constObservable(false) });
		this.sessionView.setActive(active);
		this.sessionView.layout(1, 1, 0, 0);
		this.element.classList.toggle('active', active);
		if (session) {
			this.sessionBindings.add(autorun(reader => {
				session.title.read(reader);
				session.status.read(reader);
				session.description.read(reader);
				session.modelId.read(reader);
				session.changes.read(reader);
				session.activeChat.read(reader).status.read(reader);
				this.bindChatModel();
				this.render();
			}));
		}
		this.bindChatModel();
		this.render();
	}

	getSession(): IActiveSession | undefined {
		return this.session;
	}

	private bindChatModel(): void {
		const chat = this.session?.activeChat.get();
		const resource = chat?.resource.toString();
		if (resource === this.boundModelResource) {
			return;
		}
		this.boundModelResource = resource;
		this.modelBinding.clear();
		const model = chat ? this.chatService.getSession(chat.resource) : undefined;
		if (model) {
			this.modelBinding.value = model.onDidChange(() => this.render());
		}
	}

	private render(): void {
		if (!this.transcript) {
			return;
		}
		const session = this.session;
		const status = session?.status.get() ?? SessionStatus.Untitled;
		this.statusElement.className = `jarvis-agent-status status-${status}`;
		const statusLabel = status === SessionStatus.InProgress
			? localize('jarvis.agent.working', "Working")
			: status === SessionStatus.NeedsInput
				? localize('jarvis.agent.needsInput', "Needs input")
				: status === SessionStatus.Completed
					? localize('jarvis.agent.done', "Done")
					: status === SessionStatus.Error
						? localize('jarvis.agent.error', "Error")
						: localize('jarvis.agent.ready', "Ready");
		this.statusElement.textContent = statusLabel;
		this.statusElement.title = statusLabel;
		this.statusElement.setAttribute('aria-label', statusLabel);
		this.modelElement.textContent = friendlyModelLabel(session?.modelId.get(), session?.providerId, session?.sessionType);

		this.transcript.replaceChildren();
		const chat = session?.activeChat.get();
		const model = chat ? this.chatService.getSession(chat.resource) : undefined;
		const requests = model?.getRequests().slice(-4) ?? [];
		if (!requests.length && !this.optimisticQuery) {
			const empty = append(this.transcript, $('.jarvis-agent-empty'));
			append(empty, $('.jarvis-agent-empty-orb')).textContent = '✦';
			append(empty, $('.jarvis-agent-empty-title')).textContent = localize('jarvis.agent.empty', "Send a message to start");
			append(empty, $('.jarvis-agent-empty-copy')).textContent = localize('jarvis.agent.empty.copy', "Give this agent a goal. It will work here while you move around the canvas.");
		}
		for (const request of requests) {
			const turn = append(this.transcript, $('.jarvis-agent-turn'));
			const user = append(turn, $('.jarvis-agent-user-bubble'));
			user.textContent = compactChatText(request.message.text, 700);
			if (request.response) {
				const responseText = compactChatText(request.response.response.toString());
				if (responseText) {
					const response = append(turn, $('.jarvis-agent-response'));
					response.textContent = responseText;
				}
				const activity = append(turn, $('.jarvis-agent-activity'));
				const elapsed = request.response.elapsedMs;
				append(activity, $('.codicon.codicon-history'));
				append(activity, $('span')).textContent = request.response.isComplete
					? elapsed
						? localize('jarvis.agent.workedTime', "Worked {0}s", Math.max(1, Math.round(elapsed / 1000)))
						: localize('jarvis.agent.worked', "Worked")
					: localize('jarvis.agent.workingOnIt', "Working on it");
			}
		}
		if (this.optimisticQuery && !requests.some(request => request.message.text === this.optimisticQuery)) {
			const optimistic = append(this.transcript, $('.jarvis-agent-turn.optimistic'));
			append(optimistic, $('.jarvis-agent-user-bubble')).textContent = this.optimisticQuery;
			const activity = append(optimistic, $('.jarvis-agent-activity'));
			append(activity, $('.jarvis-agent-pulse'));
			append(activity, $('span')).textContent = localize('jarvis.agent.dispatching', "Starting agent…");
		}
		const description = session?.description.get()?.value;
		if (description && status === SessionStatus.InProgress) {
			const live = append(this.transcript, $('.jarvis-agent-live-step'));
			append(live, $('.jarvis-agent-pulse'));
			append(live, $('span')).textContent = compactChatText(description, 180);
		}
		this.submitButton.disabled = this.submitting;
		this.contentElement.classList.toggle('submitting', this.submitting);
		this.transcript.scrollTop = this.transcript.scrollHeight;
	}

	private async send(): Promise<void> {
		const query = this.composer.value.trim();
		if (!query || this.submitting) {
			return;
		}
		this.composer.value = '';
		this.optimisticQuery = query;
		this.submitting = true;
		this.render();
		try {
			const session = await this.submit(this.session, query);
			if (session && session !== this.session) {
				this.bind(session, true);
			}
		} finally {
			this.submitting = false;
			this.optimisticQuery = undefined;
			this.bindChatModel();
			this.render();
			this.composer.focus();
		}
	}

	protected override layoutContent(_width: number, _height: number): void {
		// The visible Jarvis surface is pure CSS; the compatibility SessionView
		// remains a detached 1×1 service target.
	}
}

/**
 * Jarvis' main workbench part: a cinematic, pannable world containing live
 * agents and tool cards, with command and creation controls fixed to the
 * viewport. The workbench continues to own service lifecycle and restoration;
 * this part only owns the spatial presentation.
 */
export class JarvisCanvasPart extends Part {

	override readonly minimumWidth = 320;
	override readonly maximumWidth = Number.POSITIVE_INFINITY;
	override readonly minimumHeight = 0;
	override readonly maximumHeight = Number.POSITIVE_INFINITY;

	private root: HTMLElement | undefined;
	private world: HTMLElement | undefined;
	private backgroundVideo: HTMLVideoElement | undefined;
	private backgroundImage: HTMLElement | undefined;
	private launcher: HTMLElement | undefined;
	private taskDrawer: HTMLElement | undefined;
	private taskList: HTMLElement | undefined;
	private taskProgressLabel: HTMLElement | undefined;
	private taskProgressValue: HTMLElement | undefined;
	private readonly taskBindings = this._register(new DisposableStore());
	private readonly providerBindings = this._register(new DisposableStore());
	private commandInput: HTMLInputElement | undefined;
	private commandModelLabel: HTMLElement | undefined;
	private progressBar: ProgressBar | undefined;
	private progressIndicator: IProgressIndicator | undefined;
	private pointerOperation: IJarvisPointerOperation | undefined;
	private camera: IJarvisCamera = { x: 0, y: 0, zoom: 1 };
	private background: JarvisBackground = 'fuji';
	private highestZ = 10;
	private placementIndex = 0;
	private readonly entries = new Map<string, IJarvisCardEntry>();
	private readonly agentKeys = new Map<string, string>();
	private readonly closedAgentKeys = new Set<string>();
	private visibleSessions: readonly (IActiveSession | undefined)[] = [];
	private activeSession: IActiveSession | undefined;
	private readonly persistScheduler = this._register(new RunOnceScheduler(() => this.persistState(), 250));
	private readonly nativeLayoutScheduler = this._register(new RunOnceScheduler(() => this.relayoutCards(), 0));

	private readonly _onDidFocusSession = this._register(new Emitter<string>());
	readonly onDidFocusSession: Event<string> = this._onDidFocusSession.event;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(
			Parts.SESSIONS_PART,
			{ hasTitle: false, borderWidth: () => 0 },
			themeService,
			storageService,
			layoutService
		);

		this.restoreState();
		const storedBackground = this.storageService.get(JARVIS_BACKGROUND_STORAGE_KEY, StorageScope.PROFILE) as JarvisBackground | undefined;
		this.background = storedBackground && BACKGROUNDS.includes(storedBackground) ? storedBackground : 'fuji';
		this._register(this.sessionsProvidersService.onDidChangeProviders(() => this.renderAgentProviders()));
	}

	override create(parent: HTMLElement): void {
		this.element = parent;
		super.create(parent);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const root = append(parent, $('.jarvis-canvas'));
		this.root = root;
		root.dataset.background = this.background;

		const backdrop = append(root, $('.jarvis-canvas-backdrop'));
		this.backgroundImage = append(backdrop, $('.jarvis-canvas-backdrop-image'));
		this.backgroundVideo = append(backdrop, $('video.jarvis-canvas-backdrop-video')) as HTMLVideoElement;
		this.backgroundVideo.autoplay = true;
		this.backgroundVideo.loop = true;
		this.backgroundVideo.muted = true;
		this.backgroundVideo.playsInline = true;
		append(backdrop, $('.jarvis-canvas-backdrop-tint'));

		const viewport = append(root, $('.jarvis-canvas-viewport'));
		this.world = append(viewport, $('.jarvis-canvas-world'));

		this.createCommandCapsule(root);
		this.createLeftRail(root);
		this.createRightRail(root);
		this.createLauncher(root);
		this.createTaskDrawer(root);
		this.createPresencePill(root);

		this.progressBar = this._register(new ProgressBar(root, defaultProgressBarStyles));
		this.progressBar.hide();

		this.installCanvasInteractions(viewport);
		this.applyBackground();
		this.applyCamera();
		this.refreshAgents();
		return root;
	}

	private createCommandCapsule(root: HTMLElement): void {
		const capsule = append(root, $('.jarvis-command-capsule'));
		const model = append(capsule, $('button.jarvis-model-pill')) as HTMLButtonElement;
		model.type = 'button';
		append(model, $('.jarvis-model-mark')).textContent = '✦';
		this.commandModelLabel = append(model, $('span'));
		this.commandModelLabel.textContent = localize('jarvis.command.model', "Backboard");
		this.commandInput = append(capsule, $('input.jarvis-command-input')) as HTMLInputElement;
		this.commandInput.type = 'text';
		this.commandInput.placeholder = localize('jarvis.command.placeholder', "Command the canvas — launch agents, open terminals, browse, or inspect files…");
		this.commandInput.setAttribute('aria-label', this.commandInput.placeholder);
		const target = this.createIconButton(capsule, 'codicon-target', localize('jarvis.command.focus', "Fit cards"), () => this.fitCards());
		target.classList.add('quiet');
		this.createIconButton(capsule, 'codicon-settings-gear', localize('jarvis.command.settings', "Canvas settings"), () => this.toggleLauncher());
		this.createIconButton(capsule, 'codicon-mic', localize('jarvis.command.voice', "Voice command"), () => this.commandInput?.focus());
		this.createIconButton(capsule, 'codicon-arrow-up', localize('jarvis.command.run', "Run command"), () => this.runCommand());
		this._register(addDisposableListener(this.commandInput, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter') {
				EventHelper.stop(event, true);
				this.runCommand();
			}
		}));
	}

	private createLeftRail(root: HTMLElement): void {
		const rail = append(root, $('.jarvis-edge-rail.jarvis-edge-rail-left'));
		this.createIconButton(rail, 'codicon-layout', localize('jarvis.rail.launcher', "Open launcher"), () => this.toggleLauncher());
		this.createIconButton(rail, 'codicon-comment-discussion', localize('jarvis.rail.agent', "New Backboard agent"), () => this.createBackboardAgent());
		this.createIconButton(rail, 'codicon-terminal', localize('jarvis.rail.terminal', "New terminal"), () => this.createToolCard('terminal'));
		this.createIconButton(rail, 'codicon-window', localize('jarvis.rail.browser', "New browser"), () => this.createToolCard('browser'));
		this.createIconButton(rail, 'codicon-files', localize('jarvis.rail.file', "Open file"), () => this.createToolCard('file'));
		this.createIconButton(rail, 'codicon-symbol-color', localize('jarvis.rail.background', "Change background"), () => this.cycleBackground());
	}

	private createRightRail(root: HTMLElement): void {
		const rail = append(root, $('.jarvis-edge-rail.jarvis-edge-rail-right'));
		this.createIconButton(rail, 'codicon-globe', localize('jarvis.rail.browser', "New browser"), () => this.createToolCard('browser'));
		this.createIconButton(rail, 'codicon-code', localize('jarvis.rail.file', "Open file"), () => this.createToolCard('file'));
		this.createIconButton(rail, 'codicon-folder', localize('jarvis.rail.resources', "Open resources"), () => this.createToolCard('file'));
		this.createIconButton(rail, 'codicon-list-tree', localize('jarvis.rail.tasks', "Agent tasks"), () => this.toggleTaskDrawer());
		this.createIconButton(rail, 'codicon-sync', localize('jarvis.rail.arrange', "Arrange canvas"), () => this.arrangeCards());
		append(rail, $('.jarvis-rail-divider'));
		this.createIconButton(rail, 'codicon-cloud-upload', localize('jarvis.rail.fit', "Fit canvas"), () => this.fitCards());
	}

	private createLauncher(root: HTMLElement): void {
		this.launcher = append(root, $('.jarvis-launcher'));
		const header = append(this.launcher, $('.jarvis-launcher-header'));
		const copy = append(header, $('.jarvis-launcher-copy'));
		append(copy, $('.jarvis-launcher-kicker')).textContent = localize('jarvis.launcher.kicker', "CREATE ON CANVAS");
		append(copy, $('.jarvis-launcher-title')).textContent = localize('jarvis.launcher.title', "What should Jarvis open?");
		this.createIconButton(header, 'codicon-close', localize('jarvis.launcher.close', "Close launcher"), () => this.toggleLauncher(false));

		const grid = append(this.launcher, $('.jarvis-launcher-grid'));
		this.createLauncherTile(grid, 'codicon-comment-discussion', localize('jarvis.launcher.backboard', "Backboard Agent"), localize('jarvis.launcher.backboard.copy', "Start a native Backboard coding agent."), () => this.createBackboardAgent());
		this.createLauncherTile(grid, 'codicon-server-environment', localize('jarvis.launcher.byos', "BYOS Agent"), localize('jarvis.launcher.byos.copy', "Choose a connected agent provider."), () => this.showAgentProviders());
		this.createLauncherTile(grid, 'codicon-terminal', localize('jarvis.launcher.terminal', "Terminal"), localize('jarvis.launcher.terminal.copy', "Attach a live shell to a glass card."), () => this.createToolCard('terminal'));
		this.createLauncherTile(grid, 'codicon-globe', localize('jarvis.launcher.browser', "Browser"), localize('jarvis.launcher.browser.copy', "Open a real integrated browser view."), () => this.createToolCard('browser'));
		this.createLauncherTile(grid, 'codicon-file-code', localize('jarvis.launcher.file', "File"), localize('jarvis.launcher.file.copy', "Choose a file and reveal the editor."), () => this.createToolCard('file'));
		this.createLauncherTile(grid, 'codicon-symbol-color', localize('jarvis.launcher.backdrop', "Backdrop"), localize('jarvis.launcher.backdrop.copy', "Cycle cinematic canvas worlds."), () => this.cycleBackground());
		append(this.launcher, $('.jarvis-provider-list'));
		this.renderAgentProviders();
	}

	private createTaskDrawer(root: HTMLElement): void {
		this.taskDrawer = append(root, $('.jarvis-task-drawer'));
		const header = append(this.taskDrawer, $('.jarvis-task-header'));
		const title = append(header, $('.jarvis-task-title'));
		append(title, $('.codicon.codicon-checklist'));
		append(title, $('span')).textContent = localize('jarvis.tasks.title', "Tasks");
		this.taskProgressLabel = append(title, $('.jarvis-task-count'));
		this.createIconButton(header, 'codicon-close', localize('jarvis.tasks.close', "Close tasks"), () => this.toggleTaskDrawer(false));

		const progress = append(this.taskDrawer, $('.jarvis-task-progress'));
		append(progress, $('.jarvis-task-progress-track'));
		this.taskProgressValue = append(progress, $('.jarvis-task-progress-value'));
		this.taskList = append(this.taskDrawer, $('.jarvis-task-list'));
		this.renderTaskDrawer();
	}

	private toggleTaskDrawer(force?: boolean): void {
		const drawer = this.taskDrawer;
		if (!drawer) {
			return;
		}
		drawer.classList.toggle('visible', force ?? !drawer.classList.contains('visible'));
		this.updateBrowserVisibility();
	}

	private renderTaskDrawer(): void {
		const list = this.taskList;
		if (!list) {
			return;
		}
		const sessions = this.visibleSessions.filter((session): session is IActiveSession => !!session);
		this.taskBindings.clear();
		const completed = sessions.filter(session => session.status.get() === SessionStatus.Completed).length;
		if (this.taskProgressLabel) {
			this.taskProgressLabel.textContent = `${completed}/${sessions.length}`;
		}
		if (this.taskProgressValue) {
			this.taskProgressValue.style.width = `${sessions.length ? Math.round(completed / sessions.length * 100) : 0}%`;
		}
		list.replaceChildren();
		if (!sessions.length) {
			const empty = append(list, $('.jarvis-task-empty'));
			append(empty, $('.codicon.codicon-sparkle'));
			append(empty, $('span')).textContent = localize('jarvis.tasks.empty', "Create an agent and its live work will appear here.");
			return;
		}
		for (const session of sessions) {
			const item = append(list, $('button.jarvis-task-item')) as HTMLButtonElement;
			item.type = 'button';
			const top = append(item, $('.jarvis-task-item-top'));
			append(top, $('.jarvis-task-agent')).textContent = session.title.get();
			const status = append(top, $('.jarvis-task-item-status'));
			const sessionStatus = session.status.get();
			status.classList.add(`status-${sessionStatus}`);
			status.textContent = sessionStatus === SessionStatus.InProgress
				? localize('jarvis.tasks.working', "working")
				: sessionStatus === SessionStatus.Completed
					? localize('jarvis.tasks.done', "done")
					: sessionStatus === SessionStatus.NeedsInput
						? localize('jarvis.tasks.waiting', "waiting")
						: localize('jarvis.tasks.idle', "idle");
			const description = session.description.get()?.value || localize('jarvis.tasks.noCurrentTask', "No current task");
			append(item, $('.jarvis-task-description')).textContent = compactChatText(description, 150);
			this.taskBindings.add(addDisposableListener(item, EventType.CLICK, () => {
				this.focusSession(session);
				this.toggleTaskDrawer(false);
			}));
		}
	}

	private createPresencePill(root: HTMLElement): void {
		const presence = append(root, $('.jarvis-presence-pill'));
		append(presence, $('.jarvis-presence-avatar.one')).textContent = 'J';
		append(presence, $('.jarvis-presence-avatar.two')).textContent = 'B';
		append(presence, $('span')).textContent = localize('jarvis.presence', "2 online");
	}

	private createIconButton(parent: HTMLElement, icon: string, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $(`button.jarvis-icon-button.codicon.${icon}`)) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			run();
		}));
		return button;
	}

	private createLauncherTile(parent: HTMLElement, icon: string, title: string, copy: string, run: () => void): void {
		const button = append(parent, $('button.jarvis-launcher-tile')) as HTMLButtonElement;
		button.type = 'button';
		append(button, $(`span.jarvis-launcher-tile-icon.codicon.${icon}`));
		const text = append(button, $('.jarvis-launcher-tile-text'));
		append(text, $('.jarvis-launcher-tile-title')).textContent = title;
		append(text, $('.jarvis-launcher-tile-copy')).textContent = copy;
		this._register(addDisposableListener(button, EventType.CLICK, () => run()));
	}

	private installCanvasInteractions(viewport: HTMLElement): void {
		this._register(addDisposableListener(viewport, EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0 || event.target !== viewport) {
				return;
			}
			viewport.setPointerCapture(event.pointerId);
			this.pointerOperation = {
				pointerId: event.pointerId,
				kind: 'pan',
				startClientX: event.clientX,
				startClientY: event.clientY,
				startCamera: { ...this.camera }
			};
			viewport.classList.add('panning');
		}));
		this._register(addDisposableListener(viewport, EventType.POINTER_MOVE, (event: PointerEvent) => this.handlePointerMove(event)));
		this._register(addDisposableListener(viewport, EventType.POINTER_UP, (event: PointerEvent) => this.finishPointerOperation(event)));
		this._register(addDisposableListener(viewport, 'pointercancel', (event: PointerEvent) => this.finishPointerOperation(event)));
		this._register(addDisposableListener(viewport, EventType.WHEEL, (event: WheelEvent) => {
			EventHelper.stop(event, true);
			if (event.ctrlKey || event.metaKey) {
				this.zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? -0.08 : 0.08);
			} else {
				this.camera = { ...this.camera, x: this.camera.x - event.deltaX, y: this.camera.y - event.deltaY };
				this.applyCamera();
			}
		}, { passive: false }));
	}

	private startCardInteraction(event: PointerEvent, kind: 'move' | 'resize', card: JarvisCard): void {
		if (event.button !== 0) {
			return;
		}
		EventHelper.stop(event, true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		this.focusCard(card);
		this.pointerOperation = {
			pointerId: event.pointerId,
			kind,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startCamera: { ...this.camera },
			card,
			startGeometry: { ...card.getGeometry() }
		};
		card.element.classList.add(kind === 'move' ? 'moving' : 'resizing');
	}

	private handlePointerMove(event: PointerEvent): void {
		const operation = this.pointerOperation;
		if (!operation || operation.pointerId !== event.pointerId) {
			return;
		}
		const deltaX = event.clientX - operation.startClientX;
		const deltaY = event.clientY - operation.startClientY;
		if (operation.kind === 'pan') {
			this.camera = {
				...this.camera,
				x: operation.startCamera.x + deltaX,
				y: operation.startCamera.y + deltaY
			};
			this.applyCamera();
			return;
		}
		const card = operation.card;
		const geometry = operation.startGeometry;
		if (!card || !geometry) {
			return;
		}
		const worldDeltaX = deltaX / this.camera.zoom;
		const worldDeltaY = deltaY / this.camera.zoom;
		card.setGeometry(operation.kind === 'move'
			? { ...geometry, x: geometry.x + worldDeltaX, y: geometry.y + worldDeltaY }
			: { ...geometry, width: geometry.width + worldDeltaX, height: geometry.height + worldDeltaY });
		this.nativeLayoutScheduler.schedule();
	}

	private finishPointerOperation(event: PointerEvent): void {
		if (!this.pointerOperation || this.pointerOperation.pointerId !== event.pointerId) {
			return;
		}
		this.pointerOperation.card?.element.classList.remove('moving', 'resizing');
		this.root?.classList.remove('panning');
		this.pointerOperation = undefined;
		this.persistScheduler.schedule();
		this.nativeLayoutScheduler.schedule();
	}

	private createToolCard(kind: Exclude<JarvisCardKind, 'agent'>): void {
		const id = `${kind}-${generateUuid()}`;
		let card: JarvisCard;
		switch (kind) {
			case 'terminal':
				card = this.instantiationService.createInstance(JarvisTerminalCard, id);
				break;
			case 'browser':
				card = this.instantiationService.createInstance(JarvisBrowserCard, id);
				break;
			case 'file':
				card = this.instantiationService.createInstance(JarvisFileCard, id);
				break;
		}
		this.addCard(card, kind);
		this.toggleLauncher(false);
	}

	private addCard(card: JarvisCard, kind: JarvisCardKind, preferred?: IJarvisRect): void {
		const world = this.world;
		if (!world) {
			card.dispose();
			return;
		}
		const store = new DisposableStore();
		const stored = this.readStoredCardGeometry(card.id);
			const geometry = stored ?? preferred ?? this.nextPlacement(kind);
		card.setGeometry(geometry);
		card.setZIndex(++this.highestZ);
		world.appendChild(card.element);
		this.entries.set(card.id, { card, kind, store });
		store.add(card.onDidFocus(() => this.focusCard(card)));
		store.add(card.onDidChangeGeometry(() => {
			this.persistScheduler.schedule();
			this.nativeLayoutScheduler.schedule();
		}));
		store.add(card.onDidRequestClose(() => this.removeCard(card.id)));
		store.add(addDisposableListener(card.headerElement, EventType.POINTER_DOWN, (event: PointerEvent) => this.startCardInteraction(event, 'move', card)));
		store.add(addDisposableListener(card.resizeHandleElement, EventType.POINTER_DOWN, (event: PointerEvent) => this.startCardInteraction(event, 'resize', card)));
		card.relayout();
		this.updateBrowserVisibility();
		this.persistScheduler.schedule();
	}

	private removeCard(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) {
			return;
		}
		if (entry.kind === 'agent') {
			for (const [key, cardId] of this.agentKeys) {
				if (cardId === id) {
					this.agentKeys.delete(key);
					this.closedAgentKeys.add(key);
					break;
				}
			}
		}
		this.entries.delete(id);
		entry.store.dispose();
		entry.card.element.remove();
		entry.card.dispose();
		this.persistScheduler.schedule();
	}

	private focusCard(card: JarvisCard): void {
		card.setZIndex(++this.highestZ);
		for (const entry of this.entries.values()) {
			entry.card.element.classList.toggle('active', entry.card === card);
		}
		if (card instanceof JarvisAgentCard) {
			const sessionId = card.getSession()?.sessionId;
			if (sessionId) {
				this._onDidFocusSession.fire(sessionId);
			}
		}
	}

	private refreshAgents(): void {
		if (!this.world) {
			return;
		}
		const activeKey = this.activeSession?.resource.toString() ?? '__new__';
		const currentKeys = new Set<string>();
		for (const session of this.visibleSessions) {
			const key = session?.resource.toString() ?? '__new__';
			currentKeys.add(key);
			if (this.closedAgentKeys.has(key)) {
				continue;
			}
			const cardId = this.agentKeys.get(key);
			const existing = cardId ? this.entries.get(cardId)?.card : undefined;
			if (existing instanceof JarvisAgentCard) {
				existing.bind(session, key === activeKey);
				continue;
			}
			const agentCardId = `agent-${encodeURIComponent(key)}`;
				const card = this.instantiationService.createInstance(
					JarvisAgentCard,
					agentCardId,
					session,
					(boundSession, query) => this.sendAgentMessage(boundSession, query)
				);
			this.agentKeys.set(key, agentCardId);
				const focusedGeometry = this.visibleSessions.length === 1 && ![...this.entries.values()].some(entry => entry.kind !== 'agent')
					? this.focusedAgentGeometry()
					: undefined;
				this.addCard(card, 'agent', focusedGeometry);
		}
		for (const [key, cardId] of [...this.agentKeys]) {
			if (!currentKeys.has(key)) {
				this.agentKeys.delete(key);
				this.removeCard(cardId);
			}
		}
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.visibleSessions = visible;
		this.activeSession = active;
		if (this.commandModelLabel) {
			this.commandModelLabel.textContent = friendlyModelLabel(active?.modelId.get(), active?.providerId, active?.sessionType);
		}
		this.renderTaskDrawer();
		this.refreshAgents();
	}

	focusSession(session: IActiveSession | undefined): void {
		if (!session) {
			return;
		}
		const cardId = this.agentKeys.get(session.resource.toString());
		const card = cardId ? this.entries.get(cardId)?.card : undefined;
		if (card) {
			this.focusCard(card);
			card.focus();
		}
	}

	getSessionView(sessionId: string | undefined): SessionView | undefined {
		const key = sessionId
			? [...this.agentKeys.keys()].find(candidate => {
				const cardId = this.agentKeys.get(candidate);
				const card = cardId ? this.entries.get(cardId)?.card : undefined;
				return card instanceof JarvisAgentCard && card.getSession()?.sessionId === sessionId;
			})
			: '__new__';
		const cardId = key ? this.agentKeys.get(key) : undefined;
		const card = cardId ? this.entries.get(cardId)?.card : undefined;
		return card instanceof JarvisAgentCard ? card.sessionView : undefined;
	}

	private createBackboardAgent(): void {
		const provider = this.sessionsProvidersService.getProvider(LOCAL_AGENT_HOST_PROVIDER_ID);
		const supportsBackboard = provider?.sessionTypes.some(type => type.id === SessionType.AgentHostBackboard);
		this.createAgent(provider?.id, supportsBackboard ? SessionType.AgentHostBackboard : undefined);
	}

	private async sendAgentMessage(session: IActiveSession | undefined, query: string): Promise<IActiveSession | undefined> {
		return this.instantiationService.invokeFunction(async accessor => {
			const sessionsService = accessor.get(ISessionsService);
			const managementService = accessor.get(ISessionsManagementService);
			let target: ISession | undefined = session;
			if (!target) {
				const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
				const provider = this.sessionsProvidersService.getProvider(LOCAL_AGENT_HOST_PROVIDER_ID);
				const supportsBackboard = provider?.sessionTypes.some(type => type.id === SessionType.AgentHostBackboard);
				target = sessionsService.openNewSession({
					folderUri: folder,
					providerId: provider?.id,
					sessionTypeId: supportsBackboard ? SessionType.AgentHostBackboard : undefined,
					keepPreviousDraft: true
				});
			}
			if (!target) {
				return undefined;
			}
			const chat = session?.sessionId === target.sessionId ? session.activeChat.get() : target.mainChat.get();
			if (target.status.get() === SessionStatus.Untitled || chat.status.get() === SessionStatus.Untitled) {
				await managementService.sendNewChatRequest(target, { query });
			} else {
				await managementService.sendRequest(target, chat, { query });
			}
			const active = sessionsService.activeSession.get();
			return active?.sessionId === target.sessionId ? active : session;
		});
	}

	private createAgent(providerId?: string, sessionTypeId?: string): void {
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			this.instantiationService.invokeFunction(accessor => accessor.get(ISessionsService).openNewSession({ forceNew: true }));
			this.closedAgentKeys.delete('__new__');
			this.toggleLauncher(false);
			return;
		}
		const session = this.instantiationService.invokeFunction(accessor => accessor.get(ISessionsService).openNewSession({
				folderUri: folder,
				providerId,
				sessionTypeId,
				keepPreviousDraft: true
			}));
		if (session) {
			this.closedAgentKeys.delete(session.resource.toString());
		}
		this.toggleLauncher(false);
	}

	private showAgentProviders(): void {
		this.launcher?.classList.add('show-providers');
		this.renderAgentProviders();
	}

	private renderAgentProviders(): void {
		if (!this.launcher) {
			return;
		}
		const list = this.launcher.getElementsByClassName('jarvis-provider-list')[0] as HTMLElement | undefined;
		if (!list) {
			return;
		}
		list.replaceChildren();
		this.providerBindings.clear();
		const providers = this.sessionsProvidersService.getProviders();
		append(list, $('.jarvis-provider-heading')).textContent = localize('jarvis.providers.heading', "BRING YOUR OWN AGENT");
		if (!providers.length) {
			append(list, $('.jarvis-provider-empty')).textContent = localize('jarvis.providers.empty', "No providers are connected yet.");
			return;
		}
		for (const provider of providers) {
			for (const sessionType of provider.sessionTypes) {
				const chatSessionType = sessionType.chatSessionType ?? sessionType.id;
				const isBackboard = sessionType.id === 'backboard' || chatSessionType === SessionType.AgentHostBackboard;
				const isAgentHost = chatSessionType.startsWith('agent-host-') || provider.id.includes('agent-host');
				if (isBackboard || !isAgentHost) {
					continue;
				}
				const button = append(list, $('button.jarvis-provider-button')) as HTMLButtonElement;
				button.type = 'button';
				append(button, $('.jarvis-provider-status'));
				const text = append(button, $('.jarvis-provider-text'));
				append(text, $('.jarvis-provider-name')).textContent = sessionType.label;
				append(text, $('.jarvis-provider-types')).textContent = localize('jarvis.providers.via', "BYOS via {0}", provider.label);
				this.providerBindings.add(addDisposableListener(button, EventType.CLICK, () => this.createAgent(provider.id, sessionType.id)));
			}
		}
		if (list.children.length === 1) {
			append(list, $('.jarvis-provider-empty')).textContent = localize('jarvis.providers.noByos', "No BYOS agents are connected yet.");
		}
	}

	private runCommand(): void {
		const input = this.commandInput;
		if (!input) {
			return;
		}
		const command = input.value.trim().toLowerCase();
		if (!command) {
			this.toggleLauncher();
			return;
		}
		if (command.includes('terminal') || command.startsWith('shell')) {
			this.createToolCard('terminal');
		} else if (command.includes('browser') || command.includes('browse') || command.includes('website')) {
			this.createToolCard('browser');
		} else if (command.includes('file') || command.includes('code')) {
			this.createToolCard('file');
		} else if (command.includes('background') || command.includes('backdrop') || command.includes('world')) {
			this.cycleBackground();
		} else if (command.includes('arrange') || command.includes('tidy')) {
			this.arrangeCards();
		} else {
			this.createBackboardAgent();
		}
		input.value = '';
	}

	private toggleLauncher(force?: boolean): void {
		const launcher = this.launcher;
		if (!launcher) {
			return;
		}
		const visible = force ?? !launcher.classList.contains('visible');
		launcher.classList.toggle('visible', visible);
		if (!visible) {
			launcher.classList.remove('show-providers');
		}
		this.updateBrowserVisibility();
	}

	private updateBrowserVisibility(): void {
		const occluded = !!this.launcher?.classList.contains('visible') || !!this.taskDrawer?.classList.contains('visible');
		for (const entry of this.entries.values()) {
			if (entry.card instanceof JarvisBrowserCard) {
				entry.card.setSurfaceVisible(!occluded);
			}
		}
	}

	private cycleBackground(): void {
		this.background = nextBackground(this.background);
		this.storageService.store(JARVIS_BACKGROUND_STORAGE_KEY, this.background, StorageScope.PROFILE, StorageTarget.USER);
		this.applyBackground();
		this.toggleLauncher(false);
	}

	private applyBackground(): void {
		if (!this.root || !this.backgroundVideo || !this.backgroundImage) {
			return;
		}
		this.root.dataset.background = this.background;
		if (this.background === 'fuji') {
			this.backgroundVideo.pause();
			this.backgroundVideo.removeAttribute('src');
			this.backgroundVideo.load();
			this.backgroundVideo.hidden = true;
			this.backgroundImage.hidden = false;
			this.backgroundImage.style.backgroundImage = `url("${FileAccess.asBrowserUri('vs/jarvis/browser/media/jarvis-background-fuji.png').toString(true)}")`;
			return;
		}
		this.backgroundImage.hidden = true;
		this.backgroundVideo.hidden = false;
		if (this.background === 'aurora') {
			this.backgroundVideo.removeAttribute('src');
			this.backgroundVideo.load();
			this.backgroundVideo.hidden = true;
			return;
		}
		const filename = this.background === 'sky-island' ? 'jarvis-background.mp4' : 'jarvis-background-clouds.mp4';
		this.backgroundVideo.src = FileAccess.asBrowserUri(`vs/jarvis/browser/media/${filename}`).toString(true);
		void this.backgroundVideo.play();
	}

	private nextPlacement(kind: JarvisCardKind): IJarvisRect {
		const index = this.placementIndex++;
		const column = index % 3;
		const row = Math.floor(index / 3);
		const root = this.root;
		if (kind === 'agent' && this.entries.size === 0 && root) {
			const width = Math.min(470, Math.max(390, root.clientWidth * .39));
			const height = Math.min(620, Math.max(480, root.clientHeight - 140));
			return {
				x: (root.clientWidth - width) / 2,
				y: 74,
				width,
				height
			};
		}
		const width = kind === 'browser' ? 360 : kind === 'terminal' ? 430 : 300;
		const height = kind === 'browser' ? 610 : kind === 'terminal' ? 300 : 330;
		return {
			x: 76 + column * 324 + (row % 2) * 18,
			y: 74 + row * 352 + column * 8,
			width,
			height
		};
	}

	private focusedAgentGeometry(): IJarvisRect | undefined {
		const root = this.root;
		if (!root) {
			return undefined;
		}
		const width = Math.min(470, Math.max(390, root.clientWidth * .39));
		const height = Math.min(620, Math.max(500, root.clientHeight - 144));
		return {
			x: (root.clientWidth - width) / 2,
			y: 70,
			width,
			height
		};
	}

	private arrangeCards(): void {
		const root = this.root;
		if (!root) {
			return;
		}
		const entries = [...this.entries.values()];
		const browsers = entries.filter(entry => entry.kind === 'browser');
		const gridEntries = entries.filter(entry => entry.kind !== 'browser');
		const rightReserve = browsers.length ? Math.min(390, root.clientWidth * .32) : 64;
		const availableWidth = root.clientWidth - rightReserve - 100;
		const compactWidth = Math.max(220, Math.min(310, (availableWidth - 24) / 3));
		const compactHeight = Math.max(235, Math.min(320, (root.clientHeight - 110) / 2));
		for (let index = 0; index < gridEntries.length; index++) {
			const entry = gridEntries[index];
			const column = index % 3;
			const row = Math.floor(index / 3);
			entry.card.setGeometry({
				x: 64 + column * (compactWidth + 12),
				y: 58 + row * (compactHeight + 12),
				width: compactWidth,
				height: compactHeight
			});
		}
		for (let index = 0; index < browsers.length; index++) {
			const entry = browsers[index];
			const width = Math.min(360, Math.max(300, rightReserve - 34));
			entry.card.setGeometry({
				x: root.clientWidth - width - 62 + index * (width + 18),
				y: 48,
				width,
				height: Math.max(430, root.clientHeight - 96)
			});
		}
		this.camera = { x: 0, y: 0, zoom: 1 };
		this.applyCamera();
		this.persistScheduler.schedule();
	}

	private fitCards(): void {
		const cards = [...this.entries.values()].map(entry => entry.card.getGeometry());
		const root = this.root;
		if (!cards.length || !root) {
			this.camera = { x: 0, y: 0, zoom: 1 };
			this.applyCamera();
			return;
		}
		const minX = Math.min(...cards.map(card => card.x));
		const minY = Math.min(...cards.map(card => card.y));
		const maxX = Math.max(...cards.map(card => card.x + card.width));
		const maxY = Math.max(...cards.map(card => card.y + card.height));
		const boundsWidth = maxX - minX;
		const boundsHeight = maxY - minY;
		const zoom = Math.min(1, Math.max(0.32, Math.min((root.clientWidth - 230) / boundsWidth, (root.clientHeight - 180) / boundsHeight)));
		this.camera = {
			zoom,
			x: (root.clientWidth - boundsWidth * zoom) / 2 - minX * zoom,
			y: (root.clientHeight - boundsHeight * zoom) / 2 - minY * zoom
		};
		this.applyCamera();
	}

	private zoomAt(clientX: number, clientY: number, delta: number): void {
		const nextZoom = Math.min(1.8, Math.max(0.28, this.camera.zoom + delta));
		const rootRect = this.root?.getBoundingClientRect();
		if (!rootRect) {
			return;
		}
		const localX = clientX - rootRect.left;
		const localY = clientY - rootRect.top;
		const worldX = (localX - this.camera.x) / this.camera.zoom;
		const worldY = (localY - this.camera.y) / this.camera.zoom;
		this.camera = {
			zoom: nextZoom,
			x: localX - worldX * nextZoom,
			y: localY - worldY * nextZoom
		};
		this.applyCamera();
	}

	private applyCamera(): void {
		if (this.world) {
			this.world.style.transform = `translate3d(${this.camera.x}px, ${this.camera.y}px, 0) scale(${this.camera.zoom})`;
		}
		this.nativeLayoutScheduler.schedule();
		this.persistScheduler.schedule();
	}

	private relayoutCards(): void {
		for (const entry of this.entries.values()) {
			entry.card.relayout();
		}
	}

	private readStoredCardGeometry(id: string): IJarvisRect | undefined {
		try {
			const raw = this.storageService.get(JARVIS_CANVAS_STORAGE_KEY, StorageScope.PROFILE);
			return raw ? (JSON.parse(raw) as IJarvisStoredState).cards?.[id] : undefined;
		} catch {
			return undefined;
		}
	}

	private restoreState(): void {
		try {
			const raw = this.storageService.get(JARVIS_CANVAS_STORAGE_KEY, StorageScope.PROFILE);
			const state = raw ? JSON.parse(raw) as IJarvisStoredState : undefined;
			if (state?.camera && Number.isFinite(state.camera.x) && Number.isFinite(state.camera.y) && Number.isFinite(state.camera.zoom)) {
				this.camera = {
					x: state.camera.x,
					y: state.camera.y,
					zoom: Math.min(1.8, Math.max(0.28, state.camera.zoom))
				};
			}
		} catch {
			// Corrupt canvas state is ignored.
		}
	}

	private persistState(): void {
		const cards: Record<string, IJarvisRect> = {};
		for (const [id, entry] of this.entries) {
			cards[id] = entry.card.getGeometry();
		}
		const state: IJarvisStoredState = { camera: this.camera, cards };
		this.storageService.store(JARVIS_CANVAS_STORAGE_KEY, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	getProgressIndicator(): IProgressIndicator {
		if (!this.progressIndicator) {
			const progressBar = this.progressBar;
			if (!progressBar) {
				throw new Error('Jarvis progress indicator requested before canvas creation');
			}
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
		const container = this.getContainer();
		if (!container) {
			return;
		}
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = 'transparent';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		super.layoutContents(width, height);
		this.nativeLayoutScheduler.schedule();
	}

	toJSON(): object {
		return { type: Parts.SESSIONS_PART };
	}

	override dispose(): void {
		for (const [id] of [...this.entries]) {
			this.removeCard(id);
		}
		super.dispose();
	}
}

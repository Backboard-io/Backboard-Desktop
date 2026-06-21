/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IJarvisBridge, IJarvisTerminalSlot } from '../common/jarvisTypes.js';
import type { Terminal as XtermTerminal, IDisposable as IXtermDisposable, ITheme } from '@xterm/xterm';

const terminalSlots: readonly IJarvisTerminalSlot[] = [
	{ id: 'erin', name: 'Erin' },
	{ id: 'seif', name: 'Seif' },
	{ id: 'youseph', name: 'Youseph' },
	{ id: 'jon', name: 'Jon' }
];

type JarvisSlotStatus = 'idle' | 'opening' | 'running' | 'closed' | 'error';

interface IJarvisSlotState {
	readonly id: string;
	readonly name: string;
	status: JarvisSlotStatus;
	output: string;
	commandDraft: string;
	terminal?: XtermTerminal;
	terminalInputDisposable?: IXtermDisposable;
	lastPrompt?: string;
	error?: string;
}

const JARVIS_SYSTEM_PROMPT = [
	'You are Jarvis, the Backboard IDE voice control surface.',
	'Your job is to convert short voice commands into tool calls for the Jarvis page.',
	'Available terminal slots are Erin, Seif, Youseph, and Jon.',
	'When the user says "hey backboard, open a terminal", call open_terminal. If the user says "open 3 terminals", call open_terminal with count: 3.',
	'If the user names a slot, use that slot. If the user gives a task for a slot, such as "make Erin tell me a short story", call send_terminal_input with slot: "Erin" and input: "tell me a short story".',
	'When the user asks to type, run, ask, make, or tell something in a terminal, call send_terminal_input with the exact requested input.',
	'When the user asks to close a terminal, call close_terminal.',
	'Do not send normal coding chat messages from this page. Jarvis controls terminal cards only.'
].join('\n');

const JARVIS_VOICE_TOOLS = [
	{
		type: 'function',
		name: 'open_terminal',
		description: 'Open one of the four Jarvis terminal cards and start the Backboard CLI in it.',
		parameters: {
			type: 'object',
			properties: {
				slot: { type: 'string', enum: terminalSlots.map(slot => slot.name), description: 'Optional terminal owner slot.' }
			}
		}
	},
	{
		type: 'function',
		name: 'send_terminal_input',
		description: 'Send text to a running Jarvis terminal.',
		parameters: {
			type: 'object',
			properties: {
				slot: { type: 'string', enum: terminalSlots.map(slot => slot.name), description: 'Optional terminal owner slot.' },
				input: { type: 'string', description: 'Text to send to the terminal.' }
			},
			required: ['input']
		}
	},
	{
		type: 'function',
		name: 'close_terminal',
		description: 'Close a running Jarvis terminal card.',
			parameters: {
				type: 'object',
				properties: {
					slot: { type: 'string', enum: terminalSlots.map(slot => slot.name), description: 'Optional terminal owner slot.' },
					count: { type: 'number', minimum: 1, maximum: terminalSlots.length, description: 'Optional number of terminals to open.' }
				}
			}
		}
];

export class JarvisApp extends Disposable {

	private readonly slots = new Map<string, IJarvisSlotState>();
	private shell!: HTMLElement;
	private grid!: HTMLElement;
	private statusLine!: HTMLElement;
	private promptInput!: HTMLInputElement;
	private voiceButton!: HTMLButtonElement;
	private workspaceButton!: HTMLButtonElement;
	private selectedWorkspacePath: string | undefined;
	private xtermCtor: typeof XtermTerminal | undefined;
	private mediaRecorder: MediaRecorder | undefined;
	private mediaStream: MediaStream | undefined;
	private voiceChunks: Blob[] = [];
	private voiceFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	private isListening = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly bridge: IJarvisBridge
	) {
		super();
		for (const slot of terminalSlots) {
			this.slots.set(slot.id, {
				id: slot.id,
				name: slot.name,
				status: 'idle',
				output: '',
				commandDraft: ''
			});
		}
		this._register(this.bridge.onTerminalData(event => {
			const slot = this.slots.get(event.slotId);
			if (!slot) {
				return;
			}
			slot.status = 'running';
			slot.output = `${slot.output}${event.data}`.slice(-50000);
			if (slot.terminal) {
				slot.terminal.write(event.data);
			} else {
				this.renderGrid();
			}
		}));
		this._register(this.bridge.onTerminalExit(event => {
			const slot = this.slots.get(event.slotId);
			if (!slot) {
				return;
			}
			if (slot.status === 'idle') {
				return;
			}
			slot.status = 'closed';
			const exitMessage = `\r\n[Jarvis] Terminal exited with code ${event.exitCode ?? 0}.\r\n`;
			slot.output = `${slot.output}${exitMessage}`.slice(-50000);
			slot.terminal?.write(exitMessage);
			this.renderGrid();
		}));
	}

	async start(): Promise<void> {
		await this.loadTerminalRenderer();
		this.container.classList.add('jarvis-root');
		this.shell = document.createElement('div');
		this.shell.className = 'jarvis-shell';
		this.shell.appendChild(this.renderBackground());
		this.shell.appendChild(this.renderHeader());
		this.shell.appendChild(this.renderSideRail());
		this.shell.appendChild(this.renderCommandBar());

		this.grid = document.createElement('section');
		this.grid.className = 'jarvis-grid';
		this.shell.appendChild(this.grid);

		this.container.appendChild(this.shell);
		this.installBackboardVoice();
		this.renderGrid();
		this.updateStatus(localize('jarvis.ready', "Ready. Say or type: Hey Backboard, open a terminal."));
	}

	private renderBackground(): HTMLElement {
		const background = document.createElement('div');
		background.className = 'jarvis-background';

		const video = document.createElement('video');
		video.className = 'jarvis-background-video';
		video.src = '../browser/media/jarvis-background.mp4';
		video.autoplay = true;
		video.loop = true;
		video.muted = true;
		video.playsInline = true;
		background.appendChild(video);

		return background;
	}

	private renderHeader(): HTMLElement {
		const header = document.createElement('header');
		header.className = 'jarvis-header';

		const modeSelect = document.createElement('select');
		modeSelect.className = 'jarvis-mode-select';
		modeSelect.title = localize('jarvis.mode.select', "Switch Backboard mode");
		modeSelect.setAttribute('aria-label', modeSelect.title);
		modeSelect.appendChild(modeOption('editor', localize('jarvis.mode.editor', "Editor")));
		modeSelect.appendChild(modeOption('agents', localize('jarvis.mode.agents', "Agents")));
		modeSelect.appendChild(modeOption('optimus', localize('jarvis.mode.optimus', "Optimus")));
		modeSelect.appendChild(modeOption('jarvis', localize('jarvis.mode.jarvis', "Jarvis")));
		modeSelect.value = 'jarvis';
		modeSelect.addEventListener('change', () => {
			const value = modeSelect.value;
			if (value === 'editor') {
				this.bridge.openEditor().catch(error => this.updateStatus(errorMessage(error)));
			} else if (value === 'agents') {
				this.bridge.openAgents().catch(error => this.updateStatus(errorMessage(error)));
			} else if (value === 'optimus') {
				this.bridge.openOptimus().catch(error => this.updateStatus(errorMessage(error)));
			} else {
				this.bridge.openJarvis().catch(error => this.updateStatus(errorMessage(error)));
			}
			modeSelect.value = 'jarvis';
		});
		header.appendChild(modeSelect);

		this.workspaceButton = document.createElement('button');
		this.workspaceButton.type = 'button';
		this.workspaceButton.className = 'jarvis-workspace-select';
		this.workspaceButton.textContent = localize('jarvis.workspace.select', "Select folder");
		this.workspaceButton.title = localize('jarvis.workspace.selectTitle', "Select the workspace folder for Jarvis terminals");
		this.workspaceButton.setAttribute('aria-label', this.workspaceButton.title);
		this.workspaceButton.addEventListener('click', () => this.selectWorkspaceFolder());
		header.appendChild(this.workspaceButton);

		const brand = document.createElement('div');
		brand.className = 'jarvis-brand';
		const title = document.createElement('h1');
		title.textContent = localize('jarvis.title', "Jarvis");
		const subtitle = document.createElement('p');
		subtitle.textContent = localize('jarvis.subtitle', "Voice terminal launcher");
		brand.appendChild(title);
		brand.appendChild(subtitle);
		header.appendChild(brand);

		this.statusLine = document.createElement('div');
		this.statusLine.className = 'jarvis-status-line';
		header.appendChild(this.statusLine);

		return header;
	}

	private async selectWorkspaceFolder(): Promise<void> {
		try {
			const result = await this.bridge.selectWorkspaceFolder(this.selectedWorkspacePath);
			if (!result.accepted) {
				if (result.error) {
					this.updateStatus(result.error);
				}
				return;
			}
			this.selectedWorkspacePath = result.path;
			this.updateWorkspaceButton();
			if (this.selectedWorkspacePath) {
				await this.applyWorkspaceToRunningTerminals(this.selectedWorkspacePath);
				this.updateStatus(localize('jarvis.workspace.selected', "Workspace set to {0}.", workspaceLabel(this.selectedWorkspacePath)));
			}
		} catch (error) {
			this.updateStatus(errorMessage(error));
		}
	}

	private updateWorkspaceButton(): void {
		if (!this.workspaceButton) {
			return;
		}
		this.workspaceButton.textContent = this.selectedWorkspacePath
			? workspaceLabel(this.selectedWorkspacePath)
			: localize('jarvis.workspace.select', "Select folder");
		this.workspaceButton.title = this.selectedWorkspacePath
			? localize('jarvis.workspace.currentTitle', "Jarvis workspace: {0}", this.selectedWorkspacePath)
			: localize('jarvis.workspace.selectTitle', "Select the workspace folder for Jarvis terminals");
	}

	private async applyWorkspaceToRunningTerminals(workspacePath: string): Promise<void> {
		await Promise.all(terminalSlots.map(async slotInfo => {
			const slot = this.slots.get(slotInfo.id);
			if (slot?.status !== 'running') {
				return;
			}
			await this.bridge.writeTerminal(slot.id, `cd ${shellQuote(workspacePath)}\r`);
		}));
	}

	private renderSideRail(): HTMLElement {
		const rail = document.createElement('nav');
		rail.className = 'jarvis-side-rail';
		rail.setAttribute('aria-label', localize('jarvis.sideRail.aria', "Jarvis tools"));
		for (const item of ['↖', '◉', '▢', '◇', '○', '↗', '/', '~', 'AI']) {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = item;
			button.title = localize('jarvis.sideRail.tool', "Jarvis tool");
			rail.appendChild(button);
		}
		return rail;
	}

	private renderCommandBar(): HTMLElement {
		const commandBar = document.createElement('form');
		commandBar.className = 'jarvis-command-bar';
		commandBar.addEventListener('submit', event => {
			event.preventDefault();
			this.acceptNaturalCommand(this.promptInput.value);
			this.promptInput.value = '';
		});

		this.promptInput = document.createElement('input');
		this.promptInput.className = 'jarvis-prompt-input';
		this.promptInput.placeholder = localize('jarvis.prompt.placeholder', "Hey Backboard, open a terminal");
		this.promptInput.setAttribute('aria-label', localize('jarvis.prompt.aria', "Jarvis command"));
		commandBar.appendChild(this.promptInput);

		const submit = document.createElement('button');
		submit.type = 'submit';
		submit.className = 'jarvis-button primary';
		submit.textContent = localize('jarvis.runCommand', "Run");
		commandBar.appendChild(submit);

		this.voiceButton = document.createElement('button');
		this.voiceButton.type = 'button';
		this.voiceButton.className = 'jarvis-button';
		this.voiceButton.textContent = localize('jarvis.voice.start', "Voice");
		this.voiceButton.addEventListener('click', () => this.toggleVoice());
		commandBar.appendChild(this.voiceButton);

		return commandBar;
	}

	private renderGrid(): void {
		const activeSlots = terminalSlots
			.map(slot => this.slots.get(slot.id)!)
			.filter(slot => slot.status !== 'idle');
		this.grid.classList.toggle('empty', activeSlots.length === 0);
		for (let count = 1; count <= terminalSlots.length; count++) {
			this.grid.classList.toggle(`count-${count}`, activeSlots.length === count);
		}
		this.grid.replaceChildren(...activeSlots.map(slot => this.renderCard(slot)));
	}

	private renderCard(slot: IJarvisSlotState): HTMLElement {
		const card = document.createElement('article');
		card.className = `jarvis-card ${slot.status}`;

		const header = document.createElement('header');
		header.className = 'jarvis-card-header';
		const identity = document.createElement('div');
		identity.className = 'jarvis-card-identity';
		const dot = document.createElement('span');
		dot.className = 'jarvis-card-dot';
		const title = document.createElement('h2');
		title.textContent = slot.name;
		identity.appendChild(dot);
		identity.appendChild(title);
		header.appendChild(identity);

		const openButton = document.createElement('button');
		openButton.type = 'button';
		openButton.className = 'jarvis-icon-button';
		openButton.title = localize('jarvis.openTerminal', "Open terminal");
		openButton.setAttribute('aria-label', openButton.title);
		openButton.textContent = '+';
		openButton.disabled = slot.status === 'opening' || slot.status === 'running';
		openButton.addEventListener('click', () => this.openTerminal(slot.id));
		header.appendChild(openButton);
		card.appendChild(header);

		const meta = document.createElement('div');
		meta.className = 'jarvis-card-meta';
		meta.textContent = this.statusLabel(slot);
		card.appendChild(meta);

		const terminal = document.createElement('div');
		terminal.className = 'jarvis-terminal';
		card.appendChild(terminal);
		this.attachTerminal(slot, terminal);

		const commandForm = document.createElement('form');
		commandForm.className = 'jarvis-terminal-command';
		commandForm.addEventListener('submit', event => {
			event.preventDefault();
			const value = input.value;
			input.value = '';
			this.sendTerminalInput(slot.id, value);
		});

		const input = document.createElement('input');
		input.value = slot.commandDraft;
		input.placeholder = localize('jarvis.terminal.placeholder', "Type command");
		input.setAttribute('aria-label', localize('jarvis.terminal.aria', "Terminal command for {0}", slot.name));
		input.disabled = slot.status !== 'running';
		input.addEventListener('input', () => {
			slot.commandDraft = input.value;
		});
		commandForm.appendChild(input);

		const send = document.createElement('button');
		send.type = 'submit';
		send.className = 'jarvis-icon-button';
		send.textContent = '>';
		send.title = localize('jarvis.sendTerminalCommand', "Send command");
		send.setAttribute('aria-label', send.title);
		send.disabled = slot.status !== 'running';
		commandForm.appendChild(send);

		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'jarvis-icon-button';
		close.textContent = 'x';
		close.title = localize('jarvis.closeTerminal', "Close terminal");
		close.setAttribute('aria-label', close.title);
		close.disabled = slot.status !== 'running';
		close.addEventListener('click', () => this.disposeTerminal(slot.id));
		commandForm.appendChild(close);

		card.appendChild(commandForm);
		return card;
	}

	private attachTerminal(slot: IJarvisSlotState, container: HTMLElement): void {
		if (!slot.terminal) {
			if (!this.xtermCtor) {
				throw new Error('Jarvis terminal renderer is not loaded.');
			}
			slot.terminal = new this.xtermCtor({
				allowTransparency: true,
				cols: 124,
				rows: 34,
				cursorBlink: true,
				cursorStyle: 'bar',
				disableStdin: slot.status !== 'running',
				documentOverride: this.container.ownerDocument,
				drawBoldTextInBrightColors: true,
				fontFamily: this.cssValue('--vscode-editor-font-family', 'Menlo, Monaco, Consolas, monospace'),
				fontSize: this.terminalFontSize(),
				lineHeight: 1.22,
				scrollback: 5000,
				theme: this.terminalTheme()
			});
			slot.terminalInputDisposable = slot.terminal.onData(data => {
				this.bridge.writeTerminal(slot.id, data).catch(error => this.updateStatus(errorMessage(error)));
			});
			slot.terminal.open(container);
			if (slot.output) {
				slot.terminal.write(slot.output);
			} else {
				slot.terminal.write(this.placeholderText(slot).replace(/\n/g, '\r\n'));
			}
			requestAnimationFrame(() => slot.terminal?.focus());
			return;
		}

		if (slot.terminal.element && slot.terminal.element.parentElement !== container) {
			container.appendChild(slot.terminal.element);
		} else if (!slot.terminal.element) {
			slot.terminal.open(container);
		}
		slot.terminal.options.disableStdin = slot.status !== 'running';
		requestAnimationFrame(() => {
			this.resizeTerminalToContainer(slot, container);
		});
	}

	private resizeTerminalToContainer(slot: IJarvisSlotState, container: HTMLElement): void {
		if (!slot.terminal) {
			return;
		}
		const fontSize = this.terminalFontSize();
		const cols = Math.max(80, Math.floor(container.clientWidth / Math.max(7, fontSize * 0.58)));
		const rows = Math.max(18, Math.floor(container.clientHeight / Math.max(12, fontSize * 1.24)));
		if (slot.terminal.cols !== cols || slot.terminal.rows !== rows) {
			slot.terminal.resize(cols, rows);
		}
	}

	private terminalTheme(): ITheme {
		return {
			background: 'rgba(0, 0, 0, 0)',
			foreground: this.cssValue('--jarvis-text', '#f9f4ef'),
			cursor: this.cssValue('--vscode-terminalCursor-foreground', this.cssValue('--jarvis-focus', '#8cbcff')),
			selectionBackground: this.cssValue('--vscode-terminal-selectionBackground', 'rgba(120, 160, 255, .32)'),
			black: '#000000',
			red: this.cssValue('--vscode-terminal-ansiRed', '#cd3131'),
			green: this.cssValue('--vscode-terminal-ansiGreen', '#0dbc79'),
			yellow: this.cssValue('--vscode-terminal-ansiYellow', '#e5e510'),
			blue: this.cssValue('--vscode-terminal-ansiBlue', '#2472c8'),
			magenta: this.cssValue('--vscode-terminal-ansiMagenta', '#bc3fbc'),
			cyan: this.cssValue('--vscode-terminal-ansiCyan', '#11a8cd'),
			white: this.cssValue('--vscode-terminal-ansiWhite', '#e5e5e5'),
			brightBlack: this.cssValue('--vscode-terminal-ansiBrightBlack', '#666666'),
			brightRed: this.cssValue('--vscode-terminal-ansiBrightRed', '#f14c4c'),
			brightGreen: this.cssValue('--vscode-terminal-ansiBrightGreen', '#23d18b'),
			brightYellow: this.cssValue('--vscode-terminal-ansiBrightYellow', '#f5f543'),
			brightBlue: this.cssValue('--vscode-terminal-ansiBrightBlue', '#3b8eea'),
			brightMagenta: this.cssValue('--vscode-terminal-ansiBrightMagenta', '#d670d6'),
			brightCyan: this.cssValue('--vscode-terminal-ansiBrightCyan', '#29b8db'),
			brightWhite: this.cssValue('--vscode-terminal-ansiBrightWhite', '#e5e5e5')
		};
	}

	private cssValue(name: string, fallback: string): string {
		const value = this.container.ownerDocument.defaultView?.getComputedStyle(this.container).getPropertyValue(name).trim();
		return value || fallback;
	}

	private terminalFontSize(): number {
		const raw = this.cssValue('--vscode-editor-font-size', '13px');
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) ? Math.max(11, Math.min(14, parsed)) : 13;
	}

	private async loadTerminalRenderer(): Promise<void> {
		if (this.xtermCtor) {
			return;
		}
		const fileRoot = (globalThis as { _VSCODE_FILE_ROOT?: string })._VSCODE_FILE_ROOT;
		const xtermUrl = new URL('../node_modules/@xterm/xterm/lib/xterm.mjs', fileRoot ?? import.meta.url).href;
		const xterm = await import(xtermUrl) as typeof import('@xterm/xterm');
		this.xtermCtor = xterm.Terminal;
	}

	private installBackboardVoice(): void {
		const ownerWindow = this.container.ownerDocument.defaultView;
		if (!ownerWindow?.navigator.mediaDevices?.getUserMedia || !ownerWindow.MediaRecorder) {
			this.voiceButton.disabled = true;
			this.voiceButton.title = localize('jarvis.voice.unsupported', "Backboard voice capture is not available in this runtime.");
		}
	}

	private async toggleVoice(): Promise<void> {
		try {
			if (this.isListening) {
				this.stopVoiceRecording();
				return;
			}
			await this.startVoiceRecording();
		} catch (error) {
			this.setVoiceListening(false);
			this.updateStatus(localize('jarvis.voice.error', "Backboard voice stopped: {0}", errorMessage(error)));
		}
	}

	private async startVoiceRecording(): Promise<void> {
		const ownerWindow = this.container.ownerDocument.defaultView;
		if (!ownerWindow?.MediaRecorder) {
			throw new Error(localize('jarvis.voice.unsupported', "Backboard voice capture is not available in this runtime."));
		}
		this.voiceChunks = [];
		this.mediaStream = await ownerWindow.navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			},
		});
		const mimeType = ownerWindow.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
			? 'audio/webm;codecs=opus'
			: ownerWindow.MediaRecorder.isTypeSupported('audio/webm')
				? 'audio/webm'
				: '';
		const options = mimeType ? { mimeType } : undefined;
		this.mediaRecorder = new ownerWindow.MediaRecorder(this.mediaStream, options);
		this.mediaRecorder.ondataavailable = event => {
			if (event.data.size > 0) {
				this.voiceChunks.push(event.data);
			}
		};
		this.mediaRecorder.onstop = () => {
			this.transcribeVoiceRecording(this.mediaRecorder?.mimeType || mimeType || 'audio/webm').catch(error => {
				this.updateStatus(localize('jarvis.voice.error', "Backboard voice stopped: {0}", errorMessage(error)));
			});
		};
		this.mediaRecorder.start();
		this.setVoiceListening(true);
		this.updateStatus(localize('jarvis.voice.ready', "Listening through Backboard voice. Click Listening when done."));
	}

	private stopVoiceRecording(): void {
		if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
			this.setVoiceListening(false);
			return;
		}
		this.updateStatus(localize('jarvis.voice.processing', "Transcribing with Backboard..."));
		this.mediaRecorder.stop();
		this.setVoiceListening(false);
	}

	private async transcribeVoiceRecording(mimeType: string): Promise<void> {
		const chunks = this.voiceChunks;
		this.voiceChunks = [];
		this.mediaStream?.getTracks().forEach(track => track.stop());
		this.mediaStream = undefined;
		this.mediaRecorder = undefined;
		if (chunks.length === 0) {
			this.updateStatus(localize('jarvis.voice.noAudio', "No voice audio was captured."));
			return;
		}
		const blob = new Blob(chunks, { type: mimeType });
		const audio = new Uint8Array(await blob.arrayBuffer());
		const result = await this.bridge.transcribeVoice(audio, mimeType, JARVIS_SYSTEM_PROMPT, JARVIS_VOICE_TOOLS);
		if (!result.accepted || !result.transcript) {
			throw new Error(result.error ?? localize('jarvis.voice.noTranscript', "Backboard did not return a transcript."));
		}
		this.handleVoiceTranscript(result.transcript, true);
	}

	private setVoiceListening(listening: boolean): void {
		this.isListening = listening;
		this.voiceButton.classList.toggle('listening', listening);
		this.voiceButton.textContent = listening ? localize('jarvis.voice.listening', "Listening") : localize('jarvis.voice.start', "Voice");
	}

	private handleVoiceTranscript(text: string, isFinal: boolean): void {
		const transcript = text.trim();
		if (!transcript) {
			return;
		}
		this.promptInput.value = transcript;
		this.updateStatus(isFinal
			? localize('jarvis.voice.heard', "Jarvis heard: {0}", transcript)
			: localize('jarvis.voice.partial', "Listening: {0}", transcript));
		if (isFinal) {
			if (this.voiceFallbackTimer) {
				clearTimeout(this.voiceFallbackTimer);
			}
			this.voiceFallbackTimer = undefined;
			this.acceptNaturalCommand(transcript);
		}
	}

	private acceptNaturalCommand(rawCommand: string): void {
		const command = rawCommand.trim();
		if (!command) {
			return;
		}
		const normalized = command.toLocaleLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
		const withoutWakeWord = normalized.replace(/^hey\s+(backboard|jarvis)\s+/, '');
		const wantsTerminal = /\b(open|start|create|launch)\b/.test(withoutWakeWord) && /\b(term|terminal|shell)\b/.test(withoutWakeWord);
		const namedSlot = terminalSlots.find(slot => withoutWakeWord.includes(slot.name.toLocaleLowerCase()));
		if (wantsTerminal) {
			const requestedCount = numberFromCommand(withoutWakeWord) ?? 1;
			this.openAvailableTerminals(requestedCount, namedSlot).then(opened => {
				if (opened.length === 0) {
					this.updateStatus(localize('jarvis.terminals.full', "All four Jarvis terminals are already open."));
					return;
				}
				for (const openedSlot of opened) {
					const slot = this.slots.get(openedSlot.id);
					if (slot) {
						slot.lastPrompt = command;
					}
				}
				this.updateStatus(localize('jarvis.openedMultiple', "Opened {0}.", opened.map(slot => slot.name).join(', ')));
			}).catch(error => this.updateStatus(errorMessage(error)));
			return;
		}

		if (namedSlot) {
			const instruction = promptForNamedSlot(command, namedSlot);
			if (!instruction) {
				this.updateStatus(localize('jarvis.command.unsupported', "Jarvis heard \"{0}\". Try: Make Erin tell me a short story.", command));
				return;
			}
			this.sendPromptToSlot(namedSlot, instruction).then(() => {
				this.updateStatus(localize('jarvis.sentPrompt', "Sent prompt to {0}.", namedSlot.name));
			}).catch(error => this.updateStatus(errorMessage(error)));
			return;
		}

		this.updateStatus(localize('jarvis.command.unsupported', "Jarvis heard \"{0}\". Try: Hey Backboard, open 3 terminals.", command));
	}

	private async openAvailableTerminals(count: number, preferredSlot?: IJarvisTerminalSlot): Promise<IJarvisTerminalSlot[]> {
		const candidates = preferredSlot
			? [preferredSlot]
			: terminalSlots.filter(slot => {
				const status = this.slots.get(slot.id)?.status;
				return status !== 'running' && status !== 'opening';
			});
		const opened: IJarvisTerminalSlot[] = [];
		for (const candidate of candidates) {
			if (opened.length >= count) {
				break;
			}
			const state = this.slots.get(candidate.id);
			if (!state || state.status === 'running' || state.status === 'opening') {
				continue;
			}
			await this.openTerminal(candidate.id);
			opened.push(candidate);
		}
		return opened;
	}

	private async sendPromptToSlot(slotInfo: IJarvisTerminalSlot, prompt: string): Promise<void> {
		const slot = this.slots.get(slotInfo.id);
		if (!slot) {
			throw new Error(`Unknown Jarvis terminal: ${slotInfo.name}`);
		}
		slot.lastPrompt = prompt;
		if (slot.status !== 'running') {
			await this.openTerminal(slot.id);
			await timeout(700);
		}
		await this.sendTerminalInput(slot.id, prompt);
	}

	private async openTerminal(slotId: string): Promise<void> {
		const slot = this.slots.get(slotId);
		if (!slot || slot.status === 'running' || slot.status === 'opening') {
			return;
		}
		slot.status = 'opening';
		slot.error = undefined;
		slot.output = slot.output || `[Jarvis] Opening ${slot.name}...\r\n`;
		this.renderGrid();
		this.updateStatus(localize('jarvis.opening', "Opening {0}.", slot.name));
		try {
			await this.bridge.openTerminal(slot.id, slot.name, this.selectedWorkspacePath);
			await this.bridge.writeTerminal(slot.id, 'Backboard\r');
			slot.status = 'running';
			if (slot.terminal) {
				slot.terminal.options.disableStdin = false;
				slot.terminal.focus();
			}
			this.updateStatus(localize('jarvis.opened', "{0} terminal is running Backboard.", slot.name));
		} catch (error) {
			slot.status = 'error';
			slot.error = errorMessage(error);
			slot.output = `${slot.output}\r\n[Jarvis] ${slot.error}\r\n`;
			this.updateStatus(slot.error);
		}
		this.renderGrid();
	}

	private async sendTerminalInput(slotId: string, value: string): Promise<void> {
		const text = value.trim();
		if (!text) {
			return;
		}
		try {
			await this.bridge.writeTerminal(slotId, `${text}\r`);
		} catch (error) {
			this.updateStatus(errorMessage(error));
		}
	}

	private async disposeTerminal(slotId: string): Promise<void> {
		const slot = this.slots.get(slotId);
		if (!slot) {
			return;
		}
		try {
			await this.bridge.disposeTerminal(slotId);
			slot.status = 'idle';
			slot.output = '';
			slot.commandDraft = '';
			this.disposeSlotTerminal(slot);
		} catch (error) {
			this.updateStatus(errorMessage(error));
		}
		this.renderGrid();
	}

	private updateStatus(message: string): void {
		this.statusLine.textContent = message;
	}

	private statusLabel(slot: IJarvisSlotState): string {
		switch (slot.status) {
			case 'idle':
				return localize('jarvis.card.idle', "Ready to open by voice or button");
			case 'opening':
				return localize('jarvis.card.opening', "Opening terminal");
			case 'running':
				return localize('jarvis.card.running', "Terminal running");
			case 'closed':
				return localize('jarvis.card.closed', "Terminal closed");
			case 'error':
				return slot.error ?? localize('jarvis.card.error', "Terminal error");
		}
	}

	private placeholderText(slot: IJarvisSlotState): string {
		return [
			localize('jarvis.placeholder.line1', "$ hey backboard, open a terminal"),
			localize('jarvis.placeholder.line2', "# {0} is waiting", slot.name),
			slot.lastPrompt ? localize('jarvis.placeholder.lastPrompt', "# Last prompt: {0}", slot.lastPrompt) : ''
		].filter(line => !!line).join('\n');
	}

	override dispose(): void {
		if (this.voiceFallbackTimer) {
			clearTimeout(this.voiceFallbackTimer);
			this.voiceFallbackTimer = undefined;
		}
		if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
			this.mediaRecorder.stop();
		}
		this.mediaStream?.getTracks().forEach(track => track.stop());
		this.mediaStream = undefined;
		for (const slot of this.slots.values()) {
			this.disposeSlotTerminal(slot);
		}
		super.dispose();
	}

	private disposeSlotTerminal(slot: IJarvisSlotState): void {
		slot.terminalInputDisposable?.dispose();
		slot.terminalInputDisposable = undefined;
		slot.terminal?.dispose();
		slot.terminal = undefined;
	}
}

function modeOption(value: string, label: string): HTMLOptionElement {
	const option = document.createElement('option');
	option.value = value;
	option.textContent = label;
	return option;
}

function numberFromCommand(command: string): number | undefined {
	const digit = /\b([1-4])\b/.exec(command);
	if (digit) {
		return clampInteger(Number.parseInt(digit[1], 10), 1, terminalSlots.length);
	}
	const words = new Map<string, number>([
		['one', 1],
		['a', 1],
		['single', 1],
		['two', 2],
		['too', 2],
		['to', 2],
		['three', 3],
		['four', 4],
		['for', 4],
		['all', terminalSlots.length]
	]);
	for (const [word, count] of words) {
		if (new RegExp(`\\b${word}\\b`, 'i').test(command)) {
			return count;
		}
	}
	return undefined;
}

function promptForNamedSlot(command: string, slot: IJarvisTerminalSlot): string | undefined {
	const withoutWakeWord = command.trim().replace(/^hey\s+(backboard|jarvis)[,\s]+/i, '').trim();
	const name = escapeRegExp(slot.name);
	const patterns = [
		new RegExp(`^(please\\s+)?make\\s+${name}\\s+(?:to\\s+)?`, 'i'),
		new RegExp(`^(please\\s+)?ask\\s+${name}\\s+(?:to\\s+)?`, 'i'),
		new RegExp(`^(please\\s+)?tell\\s+${name}\\s+(?:to\\s+)?`, 'i'),
		new RegExp(`^(please\\s+)?have\\s+${name}\\s+`, 'i'),
		new RegExp(`^(please\\s+)?${name}\\s+`, 'i')
	];
	for (const pattern of patterns) {
		const prompt = withoutWakeWord.replace(pattern, '').trim();
		if (prompt !== withoutWakeWord && prompt.length > 0) {
			return prompt;
		}
	}
	return undefined;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function timeout(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function workspaceLabel(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const segments = trimmed.split(/[\\/]/).filter(segment => !!segment);
	return segments.at(-1) ?? path;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

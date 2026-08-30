/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { IMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { IDisposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../../base/common/observable.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { IChatProgressMessage, IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { IChatContentPartRenderContext } from '../chatContentParts.js';
import { ChatProgressContentPart } from '../chatProgressContentPart.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/**
 * Sub-part for rendering a tool invocation in the streaming state.
 * This shows progress while the tool arguments are being streamed from the LM.
 */
export class ChatToolStreamingSubPart extends BaseChatToolInvocationSubPart {
	public readonly domNode: HTMLElement;

	public override readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation,
		private readonly context: IChatContentPartRenderContext,
		private readonly renderer: IMarkdownRenderer,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(toolInvocation);

		this.domNode = this.createStreamingPart();
	}

	private createStreamingPart(): HTMLElement {
		const container = document.createElement('div');
		container.classList.add('chat-tool-streaming-part');

		if (this.toolInvocation.kind !== 'toolInvocation') {
			return container;
		}

		const toolInvocation = this.toolInvocation;
		const state = toolInvocation.state.get();
		if (state.type !== IChatToolInvocation.StateKind.Streaming) {
			return container;
		}

		const messageContainer = document.createElement('div');
		messageContainer.classList.add('chat-tool-streaming-message');
		const inputContainer = document.createElement('div');
		inputContainer.classList.add('chat-tool-streaming-input');
		inputContainer.setAttribute('aria-label', 'Streaming tool input');
		inputContainer.tabIndex = 0;
		const inputCode = document.createElement('code');
		inputContainer.appendChild(inputCode);
		container.append(messageContainer, inputContainer);

		let pendingFollowScroll: IDisposable | undefined;
		let pendingInputRender: IDisposable | undefined;
		this._register(toDisposable(() => {
			pendingFollowScroll?.dispose();
			pendingInputRender?.dispose();
		}));
		const followLatestInput = () => {
			if (pendingFollowScroll) {
				return;
			}
			pendingFollowScroll = dom.scheduleAtNextAnimationFrame(dom.getWindow(inputContainer), () => {
				pendingFollowScroll = undefined;
				inputContainer.scrollTop = inputContainer.scrollHeight;
			});
		};

		const renderedMessagePart = this._register(new MutableDisposable<ChatProgressContentPart>());
		let lastRenderedMessage: IMarkdownString | string | undefined;
		let lastRenderedMarkdownValue: string | undefined;
		let hasRenderedMessage = false;
		let latestPartialInput: unknown;
		let lastObservedPartialInput: unknown;
		let hasObservedPartialInput = false;
		let lastRenderedInput: string | undefined;
		const renderLatestInput = () => {
			pendingInputRender = undefined;
			const inputText = formatStreamingToolInput(latestPartialInput);
			if (inputText === lastRenderedInput) {
				return;
			}
			lastRenderedInput = inputText;
			container.classList.toggle('has-streaming-input', inputText.length > 0);
			if (inputText.length > 0) {
				inputCode.textContent = inputText;
				dom.show(inputContainer);
				followLatestInput();
			} else {
				inputCode.textContent = '';
				dom.hide(inputContainer);
			}
		};
		const updateStreamingInput = (input: unknown) => {
			if (hasObservedPartialInput && Object.is(input, lastObservedPartialInput)) {
				return;
			}
			hasObservedPartialInput = true;
			lastObservedPartialInput = input;
			latestPartialInput = input;

			// Show the first useful chunk immediately. Once input is visible, fold a
			// burst of argument deltas into one DOM/text-format pass per frame. Large
			// read/write payloads otherwise stringify and replace the growing input on
			// every token, producing quadratic main-thread work.
			if (!lastRenderedInput) {
				renderLatestInput();
				return;
			}
			if (!pendingInputRender) {
				pendingInputRender = dom.scheduleAtNextAnimationFrame(dom.getWindow(inputContainer), renderLatestInput);
			}
		};

		// The status and partial arguments are separate observables. Keep both in
		// one row so users can see not only that a tool is being prepared, but the
		// exact payload growing beneath it as the model produces each delta.
		this._register(autorun(reader => {
			const currentState = toolInvocation.state.read(reader);
			if (currentState.type !== IChatToolInvocation.StateKind.Streaming) {
				pendingInputRender?.dispose();
				pendingInputRender = undefined;
				renderedMessagePart.clear();
				// State changed - clear the container DOM before triggering re-render
				// This prevents the old streaming message from lingering
				dom.clearNode(container);
				this._onNeedsRerender.fire();
				return;
			}

			// Read the streaming message
			const streamingMessage = currentState.streamingMessage.read(reader);
			const displayMessage = streamingMessage ?? toolInvocation.invocationMessage;

			// Keep the existing progress message for chat hosts that do not project
			// the invocation into a live activity-group header.
			const messageText = typeof displayMessage === 'string' ? displayMessage : displayMessage.value;
			const markdownValue = typeof displayMessage === 'string' ? undefined : displayMessage.value;
			const messageChanged = !hasRenderedMessage
				|| lastRenderedMessage !== displayMessage
				|| lastRenderedMarkdownValue !== markdownValue;
			if (messageChanged && (!messageText || messageText.trim().length === 0)) {
				hasRenderedMessage = true;
				lastRenderedMessage = displayMessage;
				lastRenderedMarkdownValue = markdownValue;
				renderedMessagePart.clear();
				dom.clearNode(messageContainer);
			} else if (messageChanged) {
				const content: IMarkdownString = typeof displayMessage === 'string'
					? new MarkdownString().appendText(displayMessage)
					: displayMessage;

				const progressMessage: IChatProgressMessage = {
					kind: 'progressMessage',
					content
				};

				const part = this.instantiationService.createInstance(
					ChatProgressContentPart,
					progressMessage,
					this.renderer,
					this.context,
					undefined,
					true,
					this.getIcon(),
					toolInvocation,
					false
				);

				hasRenderedMessage = true;
				lastRenderedMessage = displayMessage;
				lastRenderedMarkdownValue = markdownValue;
				renderedMessagePart.value = part;
				dom.reset(messageContainer, part.domNode);
			}

			updateStreamingInput(currentState.partialInput.read(reader));
		}));

		return container;
	}
}

/** Converts protocol strings and client-tool objects into a safe live preview. */
export function formatStreamingToolInput(input: unknown): string {
	if (input === undefined || input === null) {
		return '';
	}
	if (typeof input === 'string') {
		return input;
	}
	try {
		return JSON.stringify(input, null, 2) ?? String(input);
	} catch {
		return String(input);
	}
}

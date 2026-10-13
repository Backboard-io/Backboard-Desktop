/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function renderComposer(): string {
	return `
			<div class="composer">
			<select id="provider" class="stateControl" aria-hidden="true"></select>
			<select id="model" class="stateControl" aria-hidden="true"></select>
			<select id="mode" class="stateControl" aria-hidden="true">
				<option value="agent">Agent</option>
				<option value="ask">Ask</option>
				<option value="manual">Manual</option>
				<option value="free">Full Access</option>
			</select>
			<select id="intensity" class="stateControl" aria-hidden="true">
				<option value="fast">Fast</option>
				<option value="balanced">Balanced</option>
				<option value="deep">Deep</option>
			</select>
			<select id="imageGeneration" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="auto">Auto</option>
			</select>
			<select id="voiceMode" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="tts">TTS</option>
				<option value="stt">STT</option>
				<option value="conversation">Conversation</option>
			</select>
			<input id="mcpFigma" class="stateControl" type="checkbox" aria-hidden="true">
			<input id="mcpNotion" class="stateControl" type="checkbox" aria-hidden="true">
			<input id="mcpGoogle" class="stateControl" type="checkbox" aria-hidden="true">
			<span id="toolCount" class="stateControl" aria-hidden="true">Tools loading</span>
				<div id="popover" class="popover" role="dialog" aria-modal="false" aria-hidden="true">
				<div class="popoverHeader">
					<div id="popoverTitle" class="popoverTitle"></div>
					<button id="popoverClose" class="iconButton" type="button" title="Close" aria-label="Close"><span class="codicon codicon-close"></span></button>
				</div>
				<div id="popoverBody" class="popoverBody"></div>
			</div>
			<div id="changeStack" class="changeStack" aria-live="polite" aria-label="Pending file changes"></div>
			<div id="queueDock" class="queueDock" aria-live="polite" aria-label="Queued prompts"></div>
			<form id="form">
					<div class="composerCard">
							<textarea id="prompt" placeholder="Message Backboard..."></textarea>
						<div class="composerRule"></div>
						<div class="composerBar">
							<div class="barLeft">
								<button id="modeBtn" class="modeButton" type="button" title="Mode and reasoning" aria-label="Mode and reasoning"><span class="modeGlyph"></span><span id="modeLabel" class="modeLabel">Agent</span><span class="codicon codicon-chevron-down"></span></button>
								<button id="modelBtn" class="modelButton" type="button" title="Backboard model" aria-label="Backboard model"><span id="modelIcon" class="modelIcon"><span class="codicon codicon-server"></span></span><span class="modelPrefix">Model</span><span id="modelLabel" class="modelValue">Auto</span><span class="codicon codicon-chevron-down"></span></button>
							</div>
							<div class="barRight">
								<button id="imageBtn" class="iconButton featureButton" type="button" title="Image output" aria-label="Image output"><span class="codicon codicon-device-camera-video"></span></button>
								<button id="voiceBtn" class="iconButton" type="button" title="Start speech-to-text" aria-label="Start speech-to-text"><span class="codicon codicon-mic"></span></button>
								<button id="stopBtn" class="iconButton stopButton" type="button" title="Stop generation" aria-label="Stop generation"><span class="codicon codicon-debug-stop"></span></button>
								<button id="sendBtn" class="iconButton sendButton" type="submit" title="Send" aria-label="Send" disabled><span class="codicon codicon-send"></span></button>
							</div>
						</div>
					</div>
				</form>
			</div>`;
}

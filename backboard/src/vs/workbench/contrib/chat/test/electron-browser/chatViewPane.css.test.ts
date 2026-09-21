/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('ChatViewPane CSS', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const css = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewPane.css'), 'utf8');
	const chatCss = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widget/media/chat.css'), 'utf8');
	const panelCss = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widget/media/chatPanelLayout.css'), 'utf8');
	const sessionsCss = readFileSync(join(process.cwd(), 'src/vs/sessions/browser/media/style.css'), 'utf8');

	function ruleBody(source: string, selector: string): string {
		const index = source.indexOf(selector);
		assert.ok(index >= 0, `Missing selector ${selector}`);
		const start = source.indexOf('{', index);
		assert.ok(start >= 0, `Missing body for selector ${selector}`);
		let depth = 0;
		for (let i = start; i < source.length; i++) {
			if (source[i] === '{') {
				depth++;
			} else if (source[i] === '}') {
				depth--;
				if (depth === 0) {
					return source.slice(start + 1, i);
				}
			}
		}
		assert.fail(`Unclosed body for selector ${selector}`);
	}

	test('uses the theme sidebar surface for the Backboard side-chat drawer', () => {
		const sideChat = ruleBody(css, '.chat-viewpane.has-sessions-control .agent-sessions-container.backboard-side-chat-sessions');

		assert.match(sessionsCss, /--sessions-sidebar-region-background:\s*var\(--vscode-sideBar-background,\s*var\(--vscode-editor-background\)\)/);
		assert.match(sideChat, /--backboard-side-chat-bg:\s*var\(--vscode-sideBar-background,\s*var\(--vscode-editor-background\)\)/);
		assert.match(sideChat, /background:\s*var\(--backboard-side-chat-bg\)/);
	});

	test('renders queued messages as one compact shared section', () => {
		const transcriptRoot = '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript';
		const pendingDivider = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-divider:not(.system-initiated-divider)`);
		const pendingHeader = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-divider:not(.system-initiated-divider) > .value`);
		const pendingChrome = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-request:not(.system-initiated-request) > :is(.header, .checkpoint-container, .checkpoint-restore-container, .chat-footer-toolbar)`);
		const pendingRequest = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-request:not(.system-initiated-request)`);
		const pendingValue = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-request:not(.system-initiated-request) > .value`);
		const pendingLastValue = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-request.pending-request-last:not(.system-initiated-request) > .value`);
		const pendingContent = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-request:not(.system-initiated-request) .chat-pending-row-content`);
		const pendingIcon = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-request:not(.system-initiated-request) .chat-pending-queue-icon`);
		const pendingActions = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.pending-request:not(.system-initiated-request) > .request-hover:not(.hidden):not(.has-no-actions)`);

		assert.match(pendingDivider, /display:\s*block\s*!important/);
		assert.match(pendingDivider, /padding:\s*8px var\(--bb-cursor-transcript-gutter\) 0\s*!important/);
		assert.match(pendingHeader, /display:\s*flex\s*!important/);
		assert.match(pendingHeader, /height:\s*26px\s*!important/);
		assert.match(pendingHeader, /border:\s*1px solid var\(--bb-cursor-diff-border\)/);
		assert.match(pendingHeader, /border-radius:\s*8px 8px 0 0/);
		assert.match(pendingHeader, /background:\s*var\(--bb-cursor-diff-surface\)/);
		assert.match(pendingChrome, /display:\s*none\s*!important/);
		assert.match(pendingRequest, /display:\s*block\s*!important/);
		assert.match(pendingRequest, /opacity:\s*1/);
		assert.match(pendingRequest, /max-width:\s*var\(--bb-cursor-transcript-reading-width\)/);
		assert.match(pendingValue, /display:\s*flex\s*!important/);
		assert.match(pendingValue, /height:\s*30px\s*!important/);
		assert.match(pendingValue, /min-height:\s*30px\s*!important/);
		assert.match(pendingValue, /max-height:\s*30px\s*!important/);
		assert.match(pendingValue, /flex-direction:\s*row\s*!important/);
		assert.match(pendingValue, /align-items:\s*center\s*!important/);
		assert.match(pendingValue, /padding:\s*0 56px 0 9px\s*!important/);
		assert.match(pendingValue, /border-width:\s*0 1px 1px/);
		assert.match(pendingValue, /border-radius:\s*0/);
		assert.match(pendingValue, /background:\s*var\(--bb-cursor-diff-surface\)/);
		assert.match(pendingLastValue, /border-radius:\s*0 0 8px 8px/);
		assert.match(pendingContent, /display:\s*flex/);
		assert.match(pendingContent, /align-items:\s*center/);
		assert.match(pendingIcon, /flex:\s*0 0 14px/);
		assert.match(pendingActions, /opacity:\s*0\s*!important/);
		assert.match(pendingActions, /top:\s*15px\s*!important/);
		assert.match(pendingActions, /transform:\s*translateY\(-50%\)/);
		assert.match(pendingActions, /visibility:\s*hidden/);
		assert.match(pendingActions, /pointer-events:\s*none/);
		assert.match(chatCss, /\.chat-pending-message\s*\{/);
	});

	test('caps collapsed command labels and reveals full expanded commands', () => {
		const transcriptRoot = '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript';
		const terminalCard = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-tool-wrapper.chat-thinking-cursor-terminal-row`);
		const editorTerminalCard = ruleBody(chatCss, '.monaco-workbench .chat-editor-relative .backboard-clean-chat .interactive-list.backboard-cursor-transcript .chat-thinking-tool-wrapper.chat-thinking-cursor-terminal-row');
		const terminalGutterReset = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row > .chat-tool-invocation-part,`);
		const terminalButton = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible > .chat-used-context-label .monaco-button`);
		const terminalLeadingIcon = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible > .chat-used-context-label .monaco-button > .codicon:first-child:not(.chat-collapsible-hover-chevron)`);
		const terminalLabel = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible > .chat-used-context-label :is(.monaco-button-mdlabel, .monaco-button-label)`);
		const terminalCode = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible > .chat-used-context-label :is(.monaco-button-mdlabel, .monaco-button-label) code`);
		const expandedTerminalButton = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible:not(.chat-used-context-collapsed) > .chat-used-context-label .monaco-button`);
		const expandedTerminalLabel = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible:not(.chat-used-context-collapsed) > .chat-used-context-label :is(.monaco-button-mdlabel, .monaco-button-label)`);
		const collapsedTerminalLabel = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible.chat-used-context-collapsed > .chat-used-context-label :is(.monaco-button-mdlabel, .monaco-button-label)`);
		const expandedTerminalCode = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible:not(.chat-used-context-collapsed) > .chat-used-context-label :is(.monaco-button-mdlabel, .monaco-button-label) code`);
		const terminalChevron = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible > .chat-used-context-label .chat-collapsible-hover-chevron`);
		const terminalPreview = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-collapsed-output-preview`);
		const expandedTerminalContent = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-thinking-collapsible:not(.chat-used-context-collapsed) > .chat-terminal-thinking-content`);
		const terminalEmptyState = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-output-empty`);
		const terminalOutputBody = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-output-body`);
		const terminalXterm = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row :is(.chat-terminal-output-content, .chat-terminal-output-terminal, .chat-terminal-output-terminal .xterm, .chat-terminal-output-terminal .xterm-screen, .chat-terminal-output-terminal .xterm-viewport, .chat-terminal-output-terminal .xterm-scrollable-element)`);

		assert.match(terminalCard, /--bb-cursor-terminal-surface:\s*var\(--vscode-panel-background,\s*var\(--vscode-editor-background\)\)/);
		assert.match(editorTerminalCard, /--bb-cursor-terminal-surface:\s*var\(--vscode-editor-background\)/);
		assert.match(terminalCard, /--bb-cursor-terminal-inline-inset:\s*11px/);
		assert.match(terminalCard, /width:\s*100%/);
		assert.match(terminalCard, /margin-inline:\s*0/);
		assert.match(terminalCard, /padding:\s*0/);
		assert.match(terminalCard, /text-align:\s*left/);
		assert.match(terminalGutterReset, /margin:\s*0\s*!important/);
		assert.match(terminalGutterReset, /padding:\s*0\s*!important/);
		assert.match(terminalButton, /justify-content:\s*flex-start/);
		assert.match(terminalButton, /gap:\s*0/);
		assert.match(terminalButton, /padding:\s*6px 0 6px var\(--bb-cursor-terminal-inline-inset\)/);
		assert.match(terminalLeadingIcon, /display:\s*none\s*!important/);
		assert.match(terminalLeadingIcon, /width:\s*0/);
		assert.match(terminalLabel, /display:\s*-webkit-box/);
		assert.match(terminalLabel, /max-height:\s*36px/);
		assert.match(terminalLabel, /text-overflow:\s*clip/);
		assert.match(terminalLabel, /white-space:\s*normal/);
		assert.match(terminalLabel, /overflow-wrap:\s*anywhere/);
		assert.match(terminalLabel, /-webkit-line-clamp:\s*2/);
		assert.match(terminalLabel, /line-clamp:\s*2/);
		assert.match(terminalCode, /white-space:\s*normal/);
		assert.match(terminalCode, /overflow-wrap:\s*anywhere/);
		assert.match(collapsedTerminalLabel, /display:\s*-webkit-box/);
		assert.match(collapsedTerminalLabel, /max-height:\s*60px/);
		assert.match(collapsedTerminalLabel, /overflow:\s*hidden/);
		assert.match(collapsedTerminalLabel, /-webkit-line-clamp:\s*3/);
		assert.match(collapsedTerminalLabel, /line-clamp:\s*3/);
		assert.match(expandedTerminalButton, /height:\s*auto/);
		assert.match(expandedTerminalButton, /align-items:\s*flex-start/);
		assert.match(expandedTerminalLabel, /display:\s*flex/);
		assert.match(expandedTerminalLabel, /max-height:\s*none/);
		assert.match(expandedTerminalLabel, /overflow:\s*visible/);
		assert.match(expandedTerminalLabel, /text-overflow:\s*clip/);
		assert.match(expandedTerminalLabel, /white-space:\s*normal/);
		assert.match(expandedTerminalLabel, /overflow-wrap:\s*anywhere/);
		assert.match(expandedTerminalLabel, /-webkit-line-clamp:\s*unset/);
		assert.match(expandedTerminalLabel, /line-clamp:\s*unset/);
		assert.match(expandedTerminalCode, /white-space:\s*pre-wrap/);
		assert.match(expandedTerminalCode, /overflow-wrap:\s*anywhere/);
		assert.match(terminalChevron, /width:\s*16px/);
		assert.match(terminalChevron, /height:\s*20px/);
		assert.match(terminalChevron, /flex:\s*0 0 16px/);
		assert.match(terminalChevron, /font-size:\s*12px/);
		assert.match(terminalChevron, /opacity:\s*0\.58/);
		assert.match(terminalPreview, /height:\s*auto/);
		assert.match(terminalPreview, /max-height:\s*82px/);
		assert.match(terminalPreview, /padding:\s*4px var\(--bb-cursor-terminal-inline-inset\) 6px/);
		assert.match(terminalPreview, /background:\s*var\(--bb-cursor-terminal-surface\)/);
		assert.doesNotMatch(terminalPreview, /height:\s*81px/);
		assert.match(expandedTerminalContent, /display:\s*block\s*!important/);
		assert.match(terminalEmptyState, /min-height:\s*34px/);
		assert.match(terminalEmptyState, /padding:\s*8px 0/);
		assert.match(terminalEmptyState, /overflow:\s*visible/);
		assert.match(terminalEmptyState, /font-size:\s*12px/);
		assert.match(terminalEmptyState, /font-family:\s*var\(--monaco-monospace-font\)/);
		assert.match(terminalOutputBody, /padding:\s*0 var\(--bb-cursor-terminal-inline-inset\)/);
		assert.match(terminalOutputBody, /background:\s*var\(--bb-cursor-terminal-surface\)\s*!important/);
		assert.match(terminalXterm, /margin:\s*0/);
		assert.match(terminalXterm, /padding:\s*0/);
		assert.match(terminalXterm, /background:\s*var\(--bb-cursor-terminal-surface\)\s*!important/);
	});

	test('uses one disclosure chevron spec across tool-call rows', () => {
		const transcriptRoot = '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript';

		// The shared spec: every collapsible tool row pins a 16x20 slot holding
		// the 12px glyph to the row's trailing edge.
		const canonical = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .chat-collapsible-hover-chevron {');
		assert.match(canonical, /width:\s*16px/);
		assert.match(canonical, /height:\s*20px/);
		assert.match(canonical, /flex:\s*0 0 16px/);
		assert.match(canonical, /margin:\s*0 0 0 auto/);
		assert.match(canonical, /font-size:\s*12px/);

		const workRowChevron = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .chat-thinking-box .chat-thinking-work-group .chat-used-context-label .chat-collapsible-hover-chevron');
		assert.match(workRowChevron, /width:\s*16px/);
		assert.match(workRowChevron, /height:\s*20px/);
		assert.match(workRowChevron, /flex:\s*0 0 16px/);
		assert.match(workRowChevron, /font-size:\s*12px/);

		const subagentChevron = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .chat-backboard-turn-work-body > .chat-subagent-strip .chat-collapsible-hover-chevron');
		assert.match(subagentChevron, /width:\s*16px/);
		assert.match(subagentChevron, /height:\s*20px/);
		assert.match(subagentChevron, /flex:\s*0 0 16px/);
		assert.match(subagentChevron, /margin:\s*0 0 0 auto/);
		assert.match(subagentChevron, /font-size:\s*12px/);

		// Tool input/output collapsibles span the row so their chevron lands
		// in the same trailing column as every other tool row.
		const toolWidgetTitle = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .chat-tool-invocation-part .chat-confirmation-widget .chat-confirmation-widget-title.monaco-button');
		assert.match(toolWidgetTitle, /width:\s*100%/);
		const toolWidgetChevron = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .chat-tool-invocation-part .chat-confirmation-widget .chat-confirmation-widget-title .chat-collapsible-hover-chevron');
		assert.match(toolWidgetChevron, /width:\s*16px/);
		assert.match(toolWidgetChevron, /height:\s*20px/);
		assert.match(toolWidgetChevron, /flex:\s*0 0 16px/);
		assert.match(toolWidgetChevron, /margin:\s*0 0 0 auto/);
		assert.match(toolWidgetChevron, /font-size:\s*12px/);

		// Group headers and reasoning disclosures are full rows, so their
		// chevrons pin to the same trailing column instead of trailing text.
		const groupHeader = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-box .chat-thinking-work-group > .chat-thinking-group-header {`);
		assert.match(groupHeader, /width:\s*100%/);
		const groupChevron = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-work-group > .chat-thinking-group-header > .chat-thinking-group-chevron-cursor`);
		assert.match(groupChevron, /width:\s*16px/);
		assert.match(groupChevron, /flex:\s*0 0 16px/);
		assert.match(groupChevron, /margin-left:\s*auto/);
		assert.match(groupChevron, /font-size:\s*12px/);
		const reasoningChevron = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-reasoning-chevron`);
		assert.match(reasoningChevron, /width:\s*16px/);
		assert.match(reasoningChevron, /flex:\s*0 0 16px/);
		assert.match(reasoningChevron, /margin-left:\s*auto/);
		const stackChevron = ruleBody(chatCss, `${transcriptRoot} .chat-core-tool-stack-read > .chat-core-tool-stack-header > .chat-core-tool-stack-chevron {`);
		assert.match(stackChevron, /width:\s*16px/);
		assert.match(stackChevron, /flex:\s*0 0 16px/);
		assert.match(stackChevron, /margin-left:\s*auto/);

		// Core tool cards share the disclosure slot dimensions.
		const coreToolCss = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widget/chatContentParts/media/chatCoreToolProgressPart.css'), 'utf8');
		const coreDisclosure = ruleBody(coreToolCss, 'Shared disclosure slot: same 16x20 / 12px spec as every other tool-row');
		assert.match(coreDisclosure, /width:\s*16px/);
		assert.match(coreDisclosure, /height:\s*20px/);
		assert.match(coreDisclosure, /font-size:\s*12px/);
	});

	test('keeps terminal tool output scrollback reachable', () => {
		const transcriptRoot = '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript';
		const terminalToolCss = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widget/chatContentParts/media/chatTerminalToolProgressPart.css'), 'utf8');
		const terminalScrollbar = ruleBody(terminalToolCss, '.chat-terminal-output-container .xterm-scrollable-element .xterm-scrollbar');
		const transcriptScrollbar = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-terminal-row .chat-terminal-output-container.expanded .xterm-scrollable-element .xterm-scrollbar`);

		assert.match(terminalScrollbar, /display:\s*block/);
		assert.doesNotMatch(terminalScrollbar, /display:\s*none/);
		assert.match(transcriptScrollbar, /display:\s*block/);
		assert.doesNotMatch(transcriptScrollbar, /display:\s*none/);
	});

	test('hides closed Thoughts and bounds open previews while indenting exploration details', () => {
		const transcriptRoot = '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript';
		const transcript = ruleBody(chatCss, `${transcriptRoot} {`);
		const hiddenReasoningSelector = `${transcriptRoot} .chat-thinking-box .chat-thinking-item.markdown-content[hidden]`;
		const hiddenReasoning = ruleBody(chatCss, hiddenReasoningSelector);
		const reasoning = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-box .chat-thinking-item.markdown-content {`);
		const previewReasoning = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-box .chat-thinking-item.markdown-content.chat-thinking-cursor-reasoning-preview`);
		const overflowingReasoning = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-box .chat-thinking-item.markdown-content.chat-thinking-cursor-reasoning-preview.chat-thinking-cursor-reasoning-overflowing`);
		const exploration = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-box .chat-thinking-work-group`);
		const explorationBody = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-box .chat-thinking-work-group > .chat-thinking-group-body`);
		const explorationRows = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-work-group > .chat-thinking-group-body > :is(.chat-thinking-cursor-read-row, .chat-thinking-cursor-search-row)`);
		const collapsedExploration = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-box .chat-thinking-work-group.chat-thinking-work-summary-collapsed > .chat-thinking-group-body`);

		assert.match(transcript, /--bb-cursor-transcript-detail-inset:\s*10px/);
		assert.match(hiddenReasoning, /display:\s*none\s*!important/);
		assert.ok(chatCss.indexOf(hiddenReasoningSelector) >= 0, 'The hidden rule must include the thinking-box specificity guard against the later !important base display');
		assert.match(reasoning, /width:\s*100%/);
		assert.match(reasoning, /margin:\s*0 0 10px/);
		assert.match(reasoning, /padding:\s*2px 0/);
		assert.match(reasoning, /border-radius:\s*0/);
		assert.match(reasoning, /background:\s*transparent/);
		assert.match(previewReasoning, /max-height:\s*calc\(14\.5em \+ 4px\)/);
		assert.match(previewReasoning, /overflow-x:\s*hidden/);
		assert.match(previewReasoning, /overflow-y:\s*auto/);
		assert.doesNotMatch(previewReasoning, /overscroll-behavior/);
		assert.match(previewReasoning, /scrollbar-width:\s*none/);
		assert.doesNotMatch(previewReasoning, /mask-image/);
		assert.match(overflowingReasoning, /-webkit-mask-image:\s*linear-gradient\(to bottom, transparent 0,[^;]+transparent 100%\)/);
		assert.match(overflowingReasoning, /mask-image:\s*linear-gradient\(to bottom, transparent 0,[^;]+transparent 100%\)/);
		assert.match(overflowingReasoning, /#000 calc\(100% - 26px\)/);
		assert.match(exploration, /width:\s*100%/);
		assert.match(exploration, /margin:\s*0 0 6px/);
		assert.doesNotMatch(exploration, /margin:\s*[^;]*var\(--bb-cursor-transcript-detail-inset\)/);
		assert.match(explorationBody, /width:\s*100%/);
		assert.match(explorationBody, /margin-left:\s*0/);
		assert.match(explorationRows, /margin-inline-start:\s*var\(--bb-cursor-transcript-exploration-inset\)/);
		assert.match(collapsedExploration, /display:\s*none/);
	});

	test('aligns transcript rows and spaces adjacent Backboard diff cards without spacer nodes', () => {
		const transcriptRoot = '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript';
		const transcript = ruleBody(chatCss, `${transcriptRoot} {`);
		const alignedRows = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.interactive-response > .value > .rendered-markdown,`);
		const adjacentDiffRows = ruleBody(chatCss, `${transcriptRoot} .chat-thinking-cursor-edit-row + .chat-thinking-cursor-edit-row,`);
		const adjacentResponseDiffs = ruleBody(chatCss, `${transcriptRoot} .interactive-item-container.interactive-response > .value > :is(.chat-external-edit-card, .chat-text-edit-compact-loading) + :is(.chat-external-edit-card, .chat-text-edit-compact-loading),`);
		const adjacentDiffs = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript .chat-backboard-turn-work-body > :is(.chat-external-edit-card, .chat-text-edit-compact-loading) + :is(.chat-external-edit-card, .chat-text-edit-compact-loading)');
		const previewCard = ruleBody(chatCss, ':is(.monaco-workbench .part.auxiliarybar .chat-viewpane, .monaco-workbench.agent-sessions-workbench .part.sessionspart .chat-view-chat.backboard-clean-chat.backboard-composer) .interactive-list.backboard-cursor-transcript .interactive-item-container.interactive-response .chat-external-edit-card.chat-external-edit-preview');
		const previewMarginReset = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .backboard-cursor-transcript .chat-external-edit-card.chat-external-edit-preview');
		assert.match(transcript, /--bb-cursor-diff-gap:\s*10px/);
		assert.match(alignedRows, /inset-inline-start:\s*0/);
		assert.match(alignedRows, /width:\s*100%/);
		assert.doesNotMatch(previewCard, /margin(?:-(?:block|top))?\s*:/, 'the high-specificity preview rule must not suppress adjacent-card spacing');
		assert.match(previewMarginReset, /margin:\s*0/);
		assert.match(adjacentDiffRows, /margin-block-start:\s*var\(--bb-cursor-diff-gap\)/);
		assert.match(adjacentResponseDiffs, /margin-block-start:\s*var\(--bb-cursor-diff-gap\)/);
		assert.match(adjacentDiffs, /margin-block-start:\s*var\(--bb-cursor-diff-gap\)/);
	});

	test('uses one reduced-motion-safe aggregate empty diff for spawned edits', () => {
		const cursorWorkingStatus = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript .chat-thinking-work-row-status-working {');
		const liveEditLabel = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript .chat-thinking-work-group.chat-thinking-work-edit-live > .chat-thinking-group-header {');
		const editShell = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript .chat-thinking-work-group.chat-thinking-work-edit-live::after');
		const hiddenBatchRows = ruleBody(chatCss, '.monaco-workbench .backboard-clean-chat .interactive-list.backboard-cursor-transcript .chat-thinking-work-group.chat-thinking-work-edit-live > .chat-thinking-group-body {');
		assert.match(cursorWorkingStatus, /animation:\s*none/);
		assert.match(liveEditLabel, /width:\s*fit-content/);
		assert.match(liveEditLabel, /min-height:\s*24px/);
		assert.match(liveEditLabel, /margin:\s*0 0 6px/);
		assert.match(liveEditLabel, /border:\s*0/);
		assert.match(liveEditLabel, /background:\s*transparent/);
		assert.match(editShell, /width:\s*100%/);
		assert.match(editShell, /height:\s*112px/);
		assert.match(editShell, /border:\s*1px solid var\(--bb-cursor-diff-border\)/);
		assert.match(editShell, /border-radius:\s*8px/);
		assert.match(editShell, /39px 29px \/ 1px 83px no-repeat/);
		assert.match(editShell, /animation:\s*backboard-cursor-edit-shell-breathe 1\.8s ease-in-out infinite/);
		assert.match(hiddenBatchRows, /display:\s*none\s*!important/);
		assert.doesNotMatch(chatCss, /chat-thinking-plan-item[^,{]*::before[^}]*animation:/s);
		assert.doesNotMatch(chatCss, /backboard-cursor-edit-batch-pulse/);
		assert.doesNotMatch(chatCss, /chat-thinking-cursor-edit-pending::after/, 'pending edits must not each paint a diff skeleton');
		assert.match(chatCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*chat-thinking-work-edit-live[^}]+animation:\s*none\s*!important/);
		const coreToolCss = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widget/chatContentParts/media/chatCoreToolProgressPart.css'), 'utf8');
		const videoStage = ruleBody(coreToolCss, '.chat-core-tool-card-generating-stage {');
		assert.match(videoStage, /height:\s*148px/);
		assert.match(ruleBody(coreToolCss, '.chat-core-tool-card-generating-rail {'), /animation:\s*backboard-cursor-video-rail-travel/);
		assert.match(ruleBody(coreToolCss, '.chat-core-tool-card-generating-frame {'), /animation:\s*backboard-cursor-video-frame-cycle/);
		assert.match(ruleBody(coreToolCss, '.chat-core-tool-card-generating-sweep {'), /animation:\s*backboard-cursor-video-sweep/);
		assert.match(ruleBody(coreToolCss, '.chat-core-tool-card-generating-bar {'), /animation:\s*backboard-cursor-video-bar-travel/);
		assert.match(coreToolCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*chat-core-tool-card-generating-sweep[^}]+animation:\s*none/);
	});

	test('scopes right-panel rhythm to the chat host', () => {
		assert.doesNotMatch(panelCss, /\.monaco-workbench \.interactive-session \.interactive-input-part:not\(\.compact\)\s*\{/);
		assert.match(panelCss, /\.monaco-workbench \.part\.auxiliarybar \.chat-viewpane \.interactive-session \.interactive-input-part:not\(\.compact\)\s*\{/);
		assert.doesNotMatch(panelCss, /\.monaco-workbench \.part\.auxiliarybar > \.composite\.title\s*\{/);
		assert.match(panelCss, /\.monaco-workbench \.part\.auxiliarybar > \.composite\.title\.has-chat-tabs\s*\{/);
		assert.doesNotMatch(panelCss, /\.monaco-workbench \.part\.auxiliarybar\s*\{/);
		assert.match(panelCss, /\.monaco-workbench \.part\.auxiliarybar:has\(> \.composite\.title\.has-chat-tabs\)\s*\{/);
	});

	test('keeps every open session as a Devin-style tab in the right-panel header', () => {
		const hiddenChatSwitcher = ruleBody(panelCss, '.action-item[data-composite-id=\'workbench.panel.chat\']:not(.icon)');
		const sharedAgentPill = ruleBody(panelCss, '.monaco-workbench .composite.title.has-chat-tabs .chat-view-title-tab,');
		const activeTab = ruleBody(panelCss, '.monaco-workbench .composite.title.has-chat-tabs .chat-view-title-tab-active,');
		const panelToggle = ruleBody(panelCss, '.monaco-workbench .part.auxiliarybar > .composite.title.has-chat-tabs > .global-actions {');

		assert.match(hiddenChatSwitcher, /display:\s*none/);
		assert.match(sharedAgentPill, /padding:\s*0 10px/);
		assert.match(sharedAgentPill, /border:\s*none/);
		assert.match(sharedAgentPill, /height:\s*35px/);
		assert.match(sharedAgentPill, /background:\s*transparent/);
		assert.match(activeTab, /box-shadow:\s*inset 0 1px 0 var\(--vscode-focusBorder\)/);
		assert.match(panelToggle, /display:\s*flex/);
		// The strip never collapses to a single header tab — the draft and every
		// open session stay visible as tabs.
		assert.doesNotMatch(panelCss, /chat-view-title-empty/);
		assert.doesNotMatch(panelCss, /chat-view-title-history/);
		// ...and starting a new chat must not hide the strip with them: the
		// empty home no longer suppresses the title row, and its own action
		// column would duplicate the strip's toolbar.
		assert.doesNotMatch(panelCss, /:has\(\.chat-composer-empty\)[^{]*\.composite\.title/);
		assert.match(ruleBody(panelCss, '.monaco-workbench .part.auxiliarybar .chat-viewpane .backboard-panel-home-actions {'), /display:\s*none/);

		// Tabs squeeze to a readable floor before the strip starts scrolling.
		const compressingTab = ruleBody(panelCss, '.monaco-workbench .composite.title.has-chat-tabs .chat-view-title-tab {\n\tflex');
		assert.match(compressingTab, /flex:\s*0 1 auto/);
		assert.match(compressingTab, /min-width:\s*92px/);
	});

	test('uses one semantic transcript hook and one editor-panel rail', () => {
		assert.match(chatCss, /\.monaco-workbench \.backboard-clean-chat \.interactive-list\.backboard-cursor-transcript\s*\{/);
		assert.doesNotMatch(chatCss, /\.backboard-clean-chat\.backboard-composer \.interactive-list\.backboard-cursor-transcript/);
		// Edit previews intentionally retain their pre-session host scope. The
		// shared transcript hook owns new queue/terminal/container geometry.
		assert.match(chatCss, /:is\(\.monaco-workbench \.part\.auxiliarybar \.chat-viewpane[^\n]+\.chat-external-edit-card\.chat-external-edit-preview/);

		const panelShell = ruleBody(panelCss, '.monaco-workbench .part.auxiliarybar:has(> .composite.title.has-chat-tabs)');
		const panelTranscript = ruleBody(panelCss, '.monaco-workbench .part.auxiliarybar .chat-viewpane .backboard-clean-chat .interactive-list.backboard-cursor-transcript');
		const panelComposer = ruleBody(panelCss, '.monaco-workbench .part.auxiliarybar .chat-viewpane .backboard-composer .interactive-session .interactive-input-part');
		assert.match(panelShell, /--bb-editor-panel-gutter:\s*16px/);
		assert.match(panelTranscript, /--bb-cursor-transcript-gutter:\s*var\(--bb-editor-panel-gutter\)/);
		assert.match(panelComposer, /margin:\s*0 var\(--bb-editor-panel-gutter\)/);
	});
});

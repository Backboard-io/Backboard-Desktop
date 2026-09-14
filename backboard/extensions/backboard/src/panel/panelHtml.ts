/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { renderComposer } from './composer';
import { renderPanelHeader } from './header';
import { renderHistoryPane } from './history';
import { renderModelSelectScript } from './modelSelect';
import { renderCheckpointStrip, renderRecentTabs } from './tabs';

export function webviewLocalResourceRoots(context: vscode.ExtensionContext): vscode.Uri[] {
	return [
		context.extensionUri,
		vscode.Uri.file(path.join(context.extensionPath, '..', '..', 'node_modules', '@vscode', 'codicons', 'dist'))
	];
}

export function codiconsStylesheetUri(context: vscode.ExtensionContext, webview: vscode.Webview): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, '..', '..', 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')));
}

export function iconBaseUri(context: vscode.ExtensionContext, webview: vscode.Webview): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'icons'));
}

export function fontBaseUri(context: vscode.ExtensionContext, webview: vscode.Webview): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'fonts'));
}

export function panelHtml(webview: vscode.Webview, codiconsStylesheet: vscode.Uri, iconBase: vscode.Uri, fontBase: vscode.Uri, options: { readonly showHeader: boolean; readonly initialState?: unknown }): string {
	const nonce = newId();
	const csp = `default-src 'none'; img-src ${webview.cspSource} https: data: blob:; media-src ${webview.cspSource} https: data: blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	const backboardLogo = `${iconBase.toString()}/backboard_logo.svg`;
	const jetBrainsMonoFont = `${fontBase.toString()}/jetbrains-mono/JetBrainsMono-VariableFont_wght.ttf`;
	const jetBrainsMonoItalicFont = `${fontBase.toString()}/jetbrains-mono/JetBrainsMono-Italic-VariableFont_wght.ttf`;
	const rootRows = `${options.showHeader ? '42px ' : ''}35px 24px minmax(0, 1fr) auto`;
	const logLabel = options.showHeader ? 'aria-labelledby="chatTab"' : 'aria-label="Chat"';
	const initialStateJson = scriptJson(options.initialState ?? {});
	const header = renderPanelHeader(options.showHeader);
	const recentTabs = renderRecentTabs();
	const checkpointStrip = renderCheckpointStrip();
	const historyPane = renderHistoryPane();
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<link href="${codiconsStylesheet}" rel="stylesheet">
		<style>
			@font-face { font-family: 'JetBrains Mono'; src: url('${jetBrainsMonoFont}') format('truetype'); font-weight: 100 800; font-style: normal; font-display: swap; }
			@font-face { font-family: 'JetBrains Mono'; src: url('${jetBrainsMonoItalicFont}') format('truetype'); font-weight: 100 800; font-style: italic; font-display: swap; }
			:root {
			--bb-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #ffffff));
			--bb-surface: color-mix(in srgb, var(--vscode-sideBar-background, #fbfcfd) 88%, var(--vscode-editor-background, #ffffff));
			--bb-card: color-mix(in srgb, var(--vscode-editorWidget-background, #ffffff) 86%, var(--bb-bg));
			--bb-border: color-mix(in srgb, var(--vscode-widget-border, #e6eaf0) 72%, var(--vscode-sideBar-border, #e9edf2));
			--bb-primary: var(--vscode-focusBorder, #5b8cff);
			--bb-text: var(--vscode-foreground, #242833);
			--bb-muted: var(--vscode-descriptionForeground, #7c8797);
			--bb-subtle: color-mix(in srgb, var(--vscode-descriptionForeground, #8f9bad) 62%, transparent);
			--bb-success: #2f9f5b;
			--bb-danger: #d83e64;
			--bb-danger-bg: color-mix(in srgb, #fff2f4 82%, var(--vscode-editor-background, #ffffff));
			--bb-success-bg: color-mix(in srgb, #f0fbf4 82%, var(--vscode-editor-background, #ffffff));
			--bb-shadow: color-mix(in srgb, var(--vscode-widget-shadow, #000000) 8%, transparent);
			--bb-radius: 8px;
			--bb-composer-safe-bottom: 0px;
		}
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; min-width: 0; overflow: hidden; }
			body { padding: 0; margin: 0; color: var(--bb-text); background: var(--bb-bg); font-family: var(--vscode-font-family, "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif); font-size: var(--vscode-font-size); }
			.root { position: relative; display: grid; grid-template-rows: ${rootRows}; height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; background: var(--bb-bg); }
			.root > :not(.authOverlay) { transition: filter .18s ease, opacity .18s ease; }
			.root.authRequired > :not(.authOverlay) { filter: blur(4px); opacity: .48; pointer-events: none; user-select: none; }
			.authOverlay { position: absolute; inset: 0; z-index: 40; display: none; align-items: center; justify-content: center; padding: 22px; background: color-mix(in srgb, var(--bb-bg) 38%, transparent); }
			.root.authRequired .authOverlay { display: flex; }
			.authCard { width: min(280px, 100%); display: grid; justify-items: center; gap: 12px; padding: 22px 18px; border: 1px solid color-mix(in srgb, var(--bb-border) 82%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--bb-card) 94%, var(--bb-bg)); box-shadow: 0 18px 48px color-mix(in srgb, var(--bb-shadow) 80%, transparent); text-align: center; }
			.authLogo { width: 52px; height: 68px; display: block; color: color-mix(in srgb, var(--vscode-icon-foreground, var(--bb-text)) 62%, var(--bb-primary)); background: currentColor; -webkit-mask: url('${backboardLogo}') center / contain no-repeat; mask: url('${backboardLogo}') center / contain no-repeat; }
			.authTitle { color: var(--bb-text); font-size: 15px; font-weight: 650; line-height: 20px; }
			.authText { max-width: 230px; color: var(--bb-muted); font-size: 12px; line-height: 17px; }
			.authButton { min-height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border-radius: 5px; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, var(--bb-primary)); font-size: 12px; font-weight: 600; }
			.authButton:hover { background: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--bb-primary) 84%, var(--bb-text))); }
			.authButton .codicon { font-size: 14px; }
		.panelHeader { min-height: 42px; box-sizing: border-box; display: flex; align-items: center; gap: 9px; padding: 6px 12px; border-bottom: 1px solid var(--bb-border); background: color-mix(in srgb, var(--bb-surface) 86%, var(--bb-bg)); }
		.brandMark { width: 24px; height: 24px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--bb-primary) 30%, var(--bb-border)); border-radius: 6px; color: var(--bb-primary); background: color-mix(in srgb, var(--bb-primary) 10%, transparent); }
		.brandMark .codicon { font-size: 14px; }
		.brandTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-text); font-size: 12px; font-weight: 650; line-height: 16px; letter-spacing: .02em; text-transform: uppercase; }
		.headerSpacer { flex: 1; min-width: 0; }
		.headerBadge { max-width: 112px; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border: 1px solid var(--bb-border); border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-card) 72%, transparent); font-size: 10.5px; line-height: 14px; }
		.headerBadge.hidden { display: none; }
		.headerActions { min-width: 0; max-width: 45%; display: flex; align-items: center; justify-content: flex-end; gap: 4px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
		.headerIconButton { width: 24px; height: 24px; flex: 0 0 auto; display: inline-grid; place-items: center; padding: 0; border-radius: 5px; color: var(--bb-muted); background: transparent; }
		.headerIconButton:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.headerIconButton.active { color: var(--bb-text); background: color-mix(in srgb, var(--bb-primary) 12%, transparent); }
		.headerIconButton .codicon { font-size: 15px; }
		.historyHeaderButton { width: auto; min-width: 34px; grid-auto-flow: column; column-gap: 3px; padding: 0 5px; }
		.tabCount { min-width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; padding: 0 3px; border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-border) 58%, transparent); font-size: 10px; line-height: 14px; }
		.recentTabsShell { position: relative; min-width: 0; min-height: 32px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; overflow: hidden; border-bottom: 1px solid color-mix(in srgb, var(--bb-border) 78%, transparent); background: color-mix(in srgb, var(--bb-bg) 96%, var(--bb-surface)); }
		.recentTabsShell::after { content: ''; position: absolute; top: 0; right: 54px; bottom: 0; width: 22px; pointer-events: none; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--bb-bg) 84%, transparent) 58%, var(--bb-bg)); }
		.recentTabs { min-width: 0; display: flex; align-items: center; gap: 1px; overflow-x: auto; overflow-y: hidden; padding: 4px 26px 4px 7px; scrollbar-width: none; }
		.recentTabs::-webkit-scrollbar { display: none; }
		.recentTab { width: max-content; min-width: 34px; max-width: min(176px, calc(50vw - 50px)); height: 23px; flex: 0 1 auto; display: inline-flex; align-items: center; gap: 4px; padding: 0 3px 0 7px; border: 1px solid transparent; border-radius: 4px; color: var(--bb-muted); background: transparent; font-size: 11.5px; line-height: 15px; text-align: left; cursor: pointer; }
		.recentTab:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.recentTab.active { color: var(--bb-text); border-color: color-mix(in srgb, var(--bb-border) 82%, transparent); background: color-mix(in srgb, var(--vscode-editor-background, var(--bb-card)) 88%, var(--bb-bg)); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--bb-primary) 34%, transparent); }
		.recentTab:focus-visible { outline: 1px solid color-mix(in srgb, var(--bb-primary) 70%, transparent); outline-offset: 2px; }
		.recentTab.running { color: var(--bb-muted); }
		.recentTabLabel { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.recentTabClose { width: 16px; height: 16px; flex: 0 0 auto; display: inline-grid; place-items: center; padding: 0; border-radius: 4px; color: var(--bb-muted); background: transparent; opacity: 0; }
		.recentTab:hover .recentTabClose, .recentTab:focus-within .recentTabClose, .recentTab.active .recentTabClose { opacity: 1; }
		.recentTabClose:hover { color: var(--bb-text); background: color-mix(in srgb, var(--bb-border) 62%, transparent); }
		.recentTabClose .codicon { font-size: 12px; }
		.recentTabsActions { position: relative; z-index: 1; display: flex; align-items: center; gap: 1px; padding: 4px 7px 4px 2px; background: var(--bb-bg); }
		.recentActionButton { height: 22px; min-width: 22px; display: inline-flex; align-items: center; justify-content: center; gap: 2px; padding: 0 4px; border-radius: 4px; color: var(--bb-muted); background: transparent; }
		.recentActionButton:hover, .recentActionButton.active { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.recentActionButton .codicon { font-size: 14px; }
			.checkpointStrip { display: none; min-width: 0; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--bb-border); background: color-mix(in srgb, var(--bb-bg) 94%, var(--bb-surface)); }
			.checkpointStrip.visible { display: none; }
		.checkpointTitle { flex: 0 0 auto; color: var(--bb-muted); font-size: 10px; font-weight: 650; text-transform: uppercase; }
		.checkpointList { min-width: 0; display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
		.checkpointList::-webkit-scrollbar { display: none; }
		.checkpointButton { height: 20px; min-width: 0; max-width: 135px; display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 0 6px; border-radius: 5px; color: var(--bb-muted); background: transparent; font-size: 11px; }
		.checkpointButton:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.checkpointButton .codicon { font-size: 12px; }
		.checkpointLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.viewStack { min-width: 0; min-height: 0; display: flex; overflow: hidden; background: var(--bb-bg); }
		.viewPane { display: none; width: 100%; min-width: 0; min-height: 0; height: 100%; }
		.viewPane.active { display: flex; }
		.composer { position: relative; min-width: 0; min-height: 0; padding: 0 10px calc(10px + var(--bb-composer-safe-bottom) + env(safe-area-inset-bottom, 0px)); border-top: 1px solid color-mix(in srgb, var(--bb-border) 58%, transparent); background: color-mix(in srgb, var(--bb-bg) 96%, var(--bb-surface)); }
		.changeStack { display: none; width: 100%; max-height: min(24vh, 168px); flex-direction: column; gap: 4px; overflow-x: hidden; overflow-y: auto; padding: 5px 0 6px; scrollbar-width: thin; }
		.changeStack.visible { display: flex; }
		.queueDock { display: none; padding: 8px 0 6px; }
		.queueDock.visible { display: block; }
		.stateControl { display: none; }
			.log { overflow-y: auto; overflow-x: hidden; min-width: 0; min-height: 0; padding: 14px 12px 18px; flex-direction: column; align-items: stretch; gap: 10px; background: var(--bb-bg); scrollbar-width: thin; overscroll-behavior: contain; }
			.log > * { flex: 0 0 auto; }
		.emptyState { margin: auto; display: grid; place-items: center; gap: 12px; transform: translateY(-8%); padding: 0 20px; }
		.emptyIcon { width: 48px; height: 64px; display: block; color: color-mix(in srgb, var(--vscode-icon-foreground, var(--bb-text)) 62%, var(--bb-primary)); background: currentColor; opacity: .72; -webkit-mask: url('${backboardLogo}') center / contain no-repeat; mask: url('${backboardLogo}') center / contain no-repeat; transition: opacity .2s ease; }
		.emptyState:hover .emptyIcon { opacity: .9; }
		.emptyTagline { color: var(--bb-muted); font-size: 13px; line-height: 20px; text-align: center; max-width: 220px; }
		.emptyHints { display: grid; gap: 4px; margin-top: 4px; }
		.emptyHint { color: var(--bb-subtle); font-size: 11px; line-height: 16px; text-align: center; }
			.messageCard { display: flex; flex-direction: column; gap: 7px; width: 100%; max-width: 100%; min-width: 0; padding: 0; border-radius: 6px; overflow-wrap: anywhere; word-break: normal; animation: bbFadeIn .16s ease; }
			.messageCard.user { position: relative; align-self: stretch; padding: 2px 2px 4px; color: var(--bb-text); border: 0; background: transparent; box-shadow: none; }
			.messageCard.user:hover { background: transparent; }
			.messageCard.assistant { align-self: stretch; width: 100%; max-width: 100%; padding: 2px 2px 4px 10px; border-left: 2px solid color-mix(in srgb, var(--bb-border) 82%, transparent); border-radius: 0; background: transparent; box-shadow: none; }
			.messageCard.reasoning { align-self: stretch; width: 100%; padding: 5px 8px; border: 1px solid color-mix(in srgb, var(--bb-border) 72%, transparent); border-radius: 6px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-surface) 68%, transparent); }
			.messageCard.reasoning > summary { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--bb-muted); font-size: 11px; font-weight: 600; user-select: none; }
			.messageCard.reasoning > summary::before { content: '✦'; font-size: 12px; }
			.messageCard.reasoning[open] > summary { margin-bottom: 5px; }
			.reasoningText { color: var(--bb-muted); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
			@keyframes bbFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
			.messageHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
			.messageRole { color: var(--bb-muted); font-size: 11px; font-weight: 600; white-space: nowrap; }
			.messageActions { display: none; align-items: center; gap: 3px; }
			.messageCard.user:hover .messageActions, .messageCard.user:focus-within .messageActions { display: flex; }
			.messageAction { width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0; border-radius: 4px; color: var(--bb-muted); background: transparent; }
			.messageAction:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
			.messageAction .codicon { font-size: 13px; }
			.messageText { min-width: 0; color: var(--bb-text); font-size: var(--vscode-font-size); line-height: 1.48; white-space: pre-wrap; overflow-wrap: anywhere; }
			.messageCard.user .messageText, .messageCard.user .messageRole { color: inherit; }
			.messageCard.assistant .messageHeader { display: none; }
			.messageMeta { align-self: flex-start; min-height: 17px; display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--bb-border) 70%, transparent); border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-bg) 72%, transparent); font-size: 10.5px; line-height: 14px; font-variant-numeric: tabular-nums; }
		.queueBlock { width: 100%; box-sizing: border-box; display: grid; gap: 8px; padding: 9px; border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, var(--bb-primary)) 55%, var(--bb-border)); border-radius: 8px; background: color-mix(in srgb, var(--vscode-input-background, var(--bb-card)) 88%, var(--bb-primary) 6%); box-shadow: 0 1px 5px color-mix(in srgb, var(--bb-shadow) 34%, transparent); }
		.queueHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--bb-text); font-size: 12px; font-weight: 600; }
		.queueTitle { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
		.queueHint { color: var(--bb-muted); font-size: 11px; font-weight: 400; white-space: nowrap; }
		.queueCard { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; padding: 7px; border: 1px solid color-mix(in srgb, var(--bb-border) 78%, transparent); border-radius: 7px; background: var(--bb-bg); }
			.queueTextarea { width: 100%; min-height: 38px; max-height: 90px; box-sizing: border-box; resize: vertical; padding: 6px; border: 1px solid var(--bb-border); border-radius: 6px; color: var(--bb-text); background: var(--vscode-input-background, transparent); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 12px; line-height: 17px; }
		.queueActions { display: flex; align-items: center; justify-content: flex-end; gap: 5px; }
		.queueButton { min-height: 26px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 4px 9px; border-radius: 4px; color: var(--bb-muted); background: transparent; font-size: 11px; }
		.queueButton.primary { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, var(--bb-primary)); }
		.queueButton.primary:hover { background: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--bb-primary) 86%, var(--bb-text))); }
		.queueButton:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.queueButton:disabled { opacity: .55; cursor: default; }
		.statusRow { width: 100%; min-height: 26px; display: flex; align-items: flex-start; gap: 8px; color: var(--bb-success); font-size: 12px; line-height: 17px; padding: 5px 2px; transition: color .2s ease; }
		.statusRow.error { color: var(--vscode-errorForeground, var(--bb-danger)); }
		.statusRow.muted { color: var(--bb-muted); }
		.statusRow.muted .statusIcon { animation: bbPulse 1.6s ease-in-out infinite; }
		@keyframes bbPulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
		.statusIcon { width: 12px; height: 12px; flex: 0 0 auto; display: grid; place-items: center; }
		.statusIcon .codicon { font-size: 12px; }
		.toolGroup { width: 100%; overflow: hidden; border: 1px solid color-mix(in srgb, var(--bb-border) 48%, transparent); border-radius: 5px; color: var(--bb-text); background: transparent; }
		.toolGroup.failed { border-color: color-mix(in srgb, var(--bb-danger) 28%, var(--bb-border)); background: color-mix(in srgb, var(--bb-danger) 4%, transparent); }
		.toolGroupHead { width: 100%; min-height: 24px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 3px 6px; color: var(--bb-text); background: transparent; text-align: left; }
		.toolGroupStatus { width: 14px; height: 14px; display: grid; place-items: center; color: var(--bb-muted); }
		.toolGroupStatus .codicon { font-size: 12px; }
		.toolGroup.running .toolGroupStatus .codicon { animation: bbSpin 1.2s linear infinite; }
		.toolGroup.failed .toolGroupStatus { color: var(--bb-danger); }
		.toolGroupMain { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
		.toolGroupTitle { flex: 0 0 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; line-height: 15px; }
		.toolGroupMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-muted); font-size: 10.5px; line-height: 14px; }
		.toolGroupToggle { width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border-radius: 3px; color: var(--bb-muted); background: transparent; }
		.toolGroupToggle .codicon { font-size: 12px; }
		.toolGroupToggle:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.toolGroupBody { display: none; gap: 0; padding: 2px 5px 5px 20px; border-top: 1px solid color-mix(in srgb, var(--bb-border) 38%, transparent); }
		.toolGroup.open .toolGroupBody { display: grid; }
		.toolCard { width: 100%; align-self: stretch; overflow: hidden; border: 0; border-radius: 4px; color: var(--bb-text); background: transparent; font-size: 10.5px; line-height: 14px; }
		.toolCard:hover { background: color-mix(in srgb, var(--bb-border) 22%, transparent); }
		.toolCard.started, .toolCard.finished { background: transparent; }
		.toolCard.failed, .toolCard.denied { background: color-mix(in srgb, var(--bb-danger) 5%, transparent); }
		.toolHead { min-height: 21px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 5px; padding: 1px 3px; }
		.toolStatusIcon { width: 14px; height: 14px; display: grid; place-items: center; color: var(--bb-muted); }
		.toolCard.started .toolStatusIcon { color: var(--bb-muted); }
		.toolCard.started .toolStatusIcon .codicon { animation: bbSpin 1.2s linear infinite; }
		@keyframes bbSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
		.toolCard.failed .toolStatusIcon, .toolCard.denied .toolStatusIcon { color: var(--bb-danger); }
		.toolStatusIcon .codicon { font-size: 12px; }
		.toolMain { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
		.toolLabel { flex: 0 0 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; font-weight: 600; line-height: 14px; }
		.toolMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-muted); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 10.5px; line-height: 14px; }
		.toolDuration { min-width: 34px; flex: 0 0 auto; padding: 0 4px; border: 0; border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-border) 18%, transparent); font-size: 10px; line-height: 14px; text-align: center; font-variant-numeric: tabular-nums; }
		.toolToggle { width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border-radius: 3px; color: var(--bb-muted); background: transparent; }
		.toolToggle .codicon { font-size: 12px; }
		.toolToggle:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.toolDetails { display: none; max-height: 160px; overflow: auto; border-top: 1px solid color-mix(in srgb, var(--bb-border) 36%, transparent); padding: 5px 7px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-bg) 78%, transparent); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 10.5px; line-height: 14px; white-space: pre-wrap; word-break: break-word; }
		.toolCard.open .toolDetails { display: block; }
		.usageRow { width: 100%; box-sizing: border-box; display: flex; align-items: flex-start; gap: 8px; padding: 3px 2px; color: var(--bb-muted); font-size: 12px; line-height: 16px; }
		.usageToggle { --usage-percent: 0; position: relative; width: 30px; height: 30px; flex: 0 0 auto; display: grid; place-items: center; padding: 0; border-radius: 50%; color: var(--bb-text); background: conic-gradient(var(--bb-primary) calc(var(--usage-percent) * 1%), color-mix(in srgb, var(--bb-border) 60%, transparent) 0); }
		.usageToggle::before { content: ''; position: absolute; inset: 4px; border-radius: 50%; background: var(--bb-bg); }
		.usageToggle:hover { box-shadow: 0 0 0 1px color-mix(in srgb, var(--bb-primary) 48%, transparent); }
		.usageWheelValue { position: relative; z-index: 1; color: var(--bb-text); font-size: 9px; font-weight: 700; line-height: 1; }
		.usageMain { min-width: 0; flex: 1; display: grid; gap: 4px; }
		.usageSummary { min-height: 30px; display: flex; align-items: center; gap: 6px; min-width: 0; }
		.usageTitle { color: var(--bb-text); font-weight: 600; white-space: nowrap; }
		.usageMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.usageDetails { display: none; grid-template-columns: repeat(auto-fit, minmax(94px, 1fr)); gap: 6px; padding: 7px; border: 1px solid var(--bb-border); border-radius: 7px; background: var(--bb-card); }
		.usageRow.open .usageDetails { display: grid; }
		.usageMetric { min-width: 0; display: grid; gap: 2px; }
		.usageMetricLabel { color: var(--bb-muted); font-size: 10px; line-height: 13px; text-transform: uppercase; }
		.usageMetricValue { color: var(--bb-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; }
		.fileCard { width: 100%; overflow: hidden; border: 1px solid color-mix(in srgb, var(--bb-border) 72%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--bb-card) 54%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--bb-primary) 34%, transparent); }
		.fileHeader { min-height: 34px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 7px 9px 7px 10px; border-bottom: 1px solid color-mix(in srgb, var(--bb-border) 70%, transparent); }
		.fileName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 11.5px; font-weight: 600; }
		.fileCount { flex: 0 0 auto; font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
		.fileCount.add { color: var(--bb-success); }
		.fileCount.remove { color: var(--bb-danger); }
		.diffLine { min-height: 18px; padding: 1px 10px; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 11px; line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
		.diffLine.add { color: var(--bb-success); background: var(--bb-success-bg); }
		.diffLine.remove { color: var(--bb-danger); background: var(--bb-danger-bg); }
		.reviewWrap { width: 100%; padding: 0; }
		.reviewCard { width: 100%; display: flex; flex-direction: column; gap: 1px; padding: 7px 8px; border: 1px solid color-mix(in srgb, var(--bb-border) 78%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--bb-card) 70%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--bb-primary) 50%, transparent); }
		.reviewHeader { min-height: 28px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px; }
		.reviewFile { min-height: 25px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px; overflow: hidden; padding: 2px 0; border-top: 1px solid color-mix(in srgb, var(--bb-border) 46%, transparent); }
		.typeDot { width: 16px; height: 16px; flex: 0 0 auto; display: grid; place-items: center; color: var(--bb-muted); }
		.typeDot .codicon { font-size: 14px; }
		.reviewTitle { min-width: 0; color: var(--bb-text); font-size: 12.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.reviewFileName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 11.5px; font-weight: 600; }
		.reviewButton { min-width: 52px; min-height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 3px 9px; border-radius: 4px; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, var(--bb-primary)); font-size: 11.5px; font-weight: 600; }
		.reviewButton.secondary { color: var(--bb-muted); background: transparent; }
		.reviewButton:disabled { cursor: default; color: var(--bb-muted); background: transparent; }
		.changeStack .reviewCard, .changeStack .fileCard { border-color: color-mix(in srgb, var(--bb-border) 50%, transparent); border-radius: 5px; background: transparent; box-shadow: none; }
		.changeStack .reviewCard { padding: 4px 6px; }
		.changeStack .reviewHeader { min-height: 22px; grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; }
		.changeStack .reviewTitle { font-size: 11px; font-weight: 600; color: var(--bb-muted); }
		.changeStack .fileCard { flex: 0 0 auto; }
		.changeStack .fileHeader { min-height: 24px; gap: 6px; padding: 4px 6px; border-bottom-color: color-mix(in srgb, var(--bb-border) 40%, transparent); }
		.changeStack .fileName, .changeStack .reviewFileName { font-size: 11px; }
		.changeStack .diffLine { min-height: 14px; padding: 0 8px; color: var(--bb-muted); background: transparent; font-size: 10.5px; line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.changeStack .diffLine.add { color: color-mix(in srgb, var(--bb-success) 76%, var(--bb-text)); background: transparent; }
		.changeStack .diffLine.remove { color: color-mix(in srgb, var(--bb-danger) 76%, var(--bb-text)); background: transparent; }
		.changeStack .typeDot { width: 14px; height: 14px; }
		.changeStack .typeDot .codicon { font-size: 12px; }
		.changeStack .reviewButton { min-width: 0; min-height: 20px; padding: 0 6px; color: var(--vscode-textLink-foreground, var(--bb-primary)); background: transparent; font-size: 11px; font-weight: 600; }
		.changeStack .reviewButton:hover { background: var(--vscode-toolbar-hoverBackground); }
		.questionCard { width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 7px; padding: 10px; border: 1px solid var(--bb-border); border-radius: 10px; background: var(--bb-bg); }
		.questionHeader { display: flex; align-items: flex-start; gap: 7px; }
		.questionTitle { flex: 1; min-width: 0; color: var(--bb-text); font-size: 13px; font-weight: 600; line-height: 18px; }
		.questionNav { display: flex; align-items: center; gap: 5px; color: var(--bb-muted); font-size: 11px; white-space: nowrap; }
		.questionOption { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 3px; border: 0; border-radius: 7px; color: var(--bb-text); background: transparent; text-align: left; }
		.questionOption:hover { background: color-mix(in srgb, var(--bb-border) 45%, transparent); }
		.questionNumber { width: 24px; height: 24px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 7px; color: #fff; background: color-mix(in srgb, var(--bb-text) 92%, #111722); font-size: 12px; font-weight: 600; }
		.questionDivider { height: 1px; background: var(--bb-border); }
		.questionInputRow { min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 3px; }
		.questionInput { flex: 1; min-width: 0; height: 24px; color: var(--bb-text); background: transparent; border: 0; outline: 0; font-size: 13px; }
		.questionSkip { min-width: 48px; min-height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--bb-border) 76%, var(--bb-muted)); border-radius: 4px; color: var(--bb-text); background: var(--bb-card); font-size: 11px; }
		.mediaBlock { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--bb-border); border-radius: 7px; color: var(--bb-muted); background: var(--bb-card); font-size: 12px; }
		.mediaBlock img { display: block; max-width: 100%; margin-top: 6px; border: 1px solid var(--bb-border); border-radius: 6px; }
		.mediaBlock audio { width: 100%; margin-top: 6px; }
		.historyPane { overflow: auto; flex-direction: column; gap: 7px; padding: 8px 10px 10px; background: var(--bb-bg); scrollbar-width: thin; }
		.historyList { display: flex; flex-direction: column; gap: 4px; }
		.historyEmpty { margin: auto; max-width: 240px; color: var(--bb-muted); text-align: center; font-size: 12px; line-height: 18px; }
		.historyItem { width: 100%; min-height: 46px; box-sizing: border-box; display: grid; gap: 3px; padding: 7px 8px; border: 1px solid transparent; border-radius: 7px; color: var(--bb-text); background: transparent; text-align: left; transition: border-color .15s ease, background .15s ease; }
		.historyItem:hover { border-color: var(--bb-border); background: color-mix(in srgb, var(--bb-card) 74%, transparent); }
		.historyItem.active { border-color: color-mix(in srgb, var(--bb-primary) 48%, var(--bb-border)); background: color-mix(in srgb, var(--bb-primary) 10%, transparent); }
		.historyItemTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; line-height: 16px; }
		.historyItemMeta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--bb-muted); font-size: 11px; line-height: 15px; }
		.historyItemStatus { flex: 0 0 auto; color: var(--bb-success); }
		.historyItemStatus.running { color: var(--bb-muted); }
		.historyItemStatus.failed, .historyItemStatus.cancelled { color: var(--bb-danger); }
		.statusBar { width: 100%; min-width: 0; min-height: 24px; display: flex; align-items: center; gap: 7px; padding: 3px 10px 4px; border-bottom: 1px solid color-mix(in srgb, var(--bb-border) 68%, transparent); background: color-mix(in srgb, var(--bb-bg) 96%, var(--bb-surface)); }
		.runClock { flex: 0 0 auto; min-width: 42px; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--bb-border) 62%, transparent); border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-bg) 72%, transparent); font-size: 10.5px; line-height: 14px; font-variant-numeric: tabular-nums; }
		.status { flex: 1 1 auto; min-width: 0; color: var(--bb-muted); font-size: 11px; min-height: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		form { display: block; width: 100%; margin: 0 auto; }
		.composerCard { min-height: 98px; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--bb-border); border-radius: 10px; background: color-mix(in srgb, var(--vscode-input-background, var(--bb-card)) 92%, var(--bb-bg)); overflow: hidden; box-shadow: 0 1px 3px color-mix(in srgb, var(--bb-shadow) 40%, transparent); transition: border-color .18s ease, box-shadow .18s ease, background .18s ease; }
		.composerCard:hover { border-color: color-mix(in srgb, var(--bb-border) 60%, var(--bb-primary) 20%); box-shadow: 0 2px 8px color-mix(in srgb, var(--bb-shadow) 60%, transparent); }
		.composerCard:focus-within { border-color: color-mix(in srgb, var(--bb-primary) 62%, var(--bb-border)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--bb-primary) 14%, transparent), 0 2px 8px color-mix(in srgb, var(--bb-shadow) 50%, transparent); }
		textarea { width: 100%; min-height: 44px; max-height: 132px; box-sizing: border-box; resize: vertical; padding: 0; border: 0; outline: 0; line-height: 20px; background: transparent; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 13px; }
		textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--bb-muted)); }
		.composerRule { display: none; }
		.composerBar { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 24px; padding: 0; overflow: hidden; }
		.barLeft, .barRight { display: flex; align-items: center; min-width: 0; }
		.barLeft { flex: 1 1 auto; gap: 8px; overflow: hidden; }
		.barRight { flex: 0 0 auto; justify-content: flex-end; gap: 11px; overflow: hidden; }
		button { border: 0; cursor: pointer; font-family: var(--vscode-font-family, "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif); }
		.iconButton { width: 20px; height: 22px; min-width: 20px; display: inline-grid; place-items: center; padding: 0; border-radius: 0; color: var(--bb-muted); background: transparent; line-height: 1; flex: 0 0 auto; }
		.iconButton .codicon { font-size: 16px; }
		.iconButton:hover { color: var(--bb-text); background: transparent; }
		.iconButton.active { color: var(--bb-primary); background: transparent; }
		.iconButton.recording { color: var(--bb-danger); background: transparent; }
		.iconButton:disabled { cursor: default; color: var(--vscode-disabledForeground); background: transparent; outline: 0; }
		.stopButton { display: none; color: var(--bb-danger); }
		.stopButton.visible { display: inline-grid; }
		.stopButton:hover { color: var(--vscode-errorForeground, var(--bb-danger)); background: color-mix(in srgb, var(--bb-danger) 12%, transparent); border-radius: 4px; }
		.featureButton.active { color: var(--bb-primary); }
		.composerCard.recording { border-color: var(--bb-danger); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bb-danger) 32%, transparent); }
		.sendButton.ready { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, var(--bb-primary)); box-shadow: 0 1px 3px color-mix(in srgb, var(--bb-primary) 28%, transparent); transition: background .15s ease, box-shadow .15s ease; }
		.sendButton.ready:hover { background: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--bb-primary) 86%, var(--bb-text))); box-shadow: 0 2px 6px color-mix(in srgb, var(--bb-primary) 36%, transparent); }
		.modelButton, .modeButton { min-width: 0; height: 22px; display: flex; align-items: center; gap: 5px; padding: 0; border-radius: 0; color: var(--bb-muted); background: transparent; font-size: 12px; overflow: hidden; flex: 0 1 auto; }
		.modeButton { max-width: 128px; }
		.modelButton { max-width: min(320px, 46vw); }
		.modelButton:hover, .modeButton:hover { color: var(--bb-text); background: transparent; }
		.modelButton.active, .modeButton.active { color: var(--bb-primary); background: transparent; }
		.modeGlyph { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 2px; background: currentColor; opacity: .85; }
		.modelIcon { width: 13px; height: 13px; flex: 0 0 auto; display: inline-grid; place-items: center; overflow: hidden; border-radius: 3px; }
		.modelIcon img, .choiceIcon img, .providerSwitchIcon img { width: 100%; height: 100%; display: block; object-fit: contain; }
		.modelIcon .codicon { font-size: 13px; }
		.modeLabel, .modelPrefix, .modelValue { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.modelPrefix { color: var(--bb-muted); }
		.modelValue { color: color-mix(in srgb, var(--bb-text) 80%, var(--bb-muted)); }
		.modelLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		@media (max-width: 520px) {
			.composerBar { gap: 8px; }
			.barLeft { gap: 6px; }
			.barRight { gap: 8px; }
			.modeButton { max-width: 92px; }
			.modelButton { max-width: min(210px, 42vw); }
			.modelPrefix { display: none; }
		}
		.drawerButton { min-height: 22px; display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-textLink-foreground, var(--bb-primary)); background: transparent; border: 0; border-radius: 0; padding: 0; font-size: 11.5px; }
		.drawerButton:hover { color: var(--vscode-textLink-activeForeground, var(--bb-text)); background: transparent; }
		.popover { position: fixed; z-index: 20; width: min(390px, calc(100vw - 8px)); max-height: min(390px, calc(100vh - 8px)); display: none; overflow: hidden; border: 1px solid var(--vscode-focusBorder, var(--bb-border)); border-radius: 8px; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--bb-bg))); color: var(--bb-text); box-shadow: 0 16px 36px color-mix(in srgb, var(--vscode-widget-shadow, #000) 34%, transparent); }
		.popover.open { display: flex; flex-direction: column; }
		.popoverHeader { min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--bb-border); background: color-mix(in srgb, var(--bb-card) 74%, transparent); }
		.popoverHeader { display: none; }
		.popoverTitle { font-size: 13px; font-weight: 650; }
		.popoverBody { overflow: auto; overflow-x: hidden; padding: 0; display: grid; gap: 0; }
		.popoverSection { display: grid; gap: 4px; }
		.popoverSection { padding: 1px 3px 3px; border-top: 0; }
		.popoverSectionTitle { color: var(--bb-muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; padding: 0 4px 3px; }
		.popoverSectionTitle { padding: 3px 6px 2px; color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 10.5px; font-weight: 600; line-height: 13px; text-transform: none; letter-spacing: 0; }
		.choiceRow { width: 100%; min-height: 24px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 5px 0 8px; border: 1px solid transparent; border-radius: 3px; color: var(--bb-text); background: transparent; text-align: left; }
		.choiceRow:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 8%, transparent)); border-color: transparent; }
		.choiceRow.selected { background: var(--vscode-list-focusBackground, color-mix(in srgb, var(--bb-primary) 14%, transparent)); border-color: transparent; color: var(--vscode-list-focusForeground, var(--bb-text)); }
		.choiceRow.disabled { cursor: default; color: var(--vscode-disabledForeground); }
		.choiceRow.disabled:hover { background: transparent; border-color: transparent; }
		.choiceIcon { width: 13px; height: 13px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 0; color: var(--vscode-descriptionForeground, var(--bb-muted)); background: transparent; }
		.choiceIcon .codicon { font-size: 12px; }
		.choiceMain { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 0; }
		.choiceLabel { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; line-height: 16px; }
		.choiceMeta { min-width: 0; max-width: 54%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 10px; line-height: 14px; text-align: right; }
		.choiceRow.selected .choiceMeta { color: var(--vscode-list-focusForeground, var(--bb-text)); opacity: .78; }
		.choiceRow > .codicon-check { width: 12px; flex: 0 0 auto; color: var(--vscode-focusBorder, var(--bb-primary)); font-size: 12px; }
		.popoverActions { display: flex; flex-wrap: wrap; gap: 10px; padding: 4px 8px 5px; }
		.popoverSearch { width: 100%; height: 32px; box-sizing: border-box; padding: 5px 9px; border: 1px solid var(--bb-border); border-radius: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); outline: 0; font-size: 12px; }
		.popoverSearch:focus { border-color: var(--bb-primary); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bb-primary) 30%, transparent); }
		.popoverSearch { height: 28px; padding: 0 8px; border: 0; border-radius: 0; color: var(--vscode-input-foreground, var(--bb-text)); background: transparent; font-size: 12px; }
		.popoverSearch:focus { border-color: transparent; box-shadow: inset 2px 0 0 var(--vscode-focusBorder, var(--bb-primary)); }
		.modelFilterWrap { position: sticky; top: 0; z-index: 5; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--bb-bg))); border-bottom: 1px solid var(--bb-border); }
		.modelFilterBar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 3px; min-height: 28px; padding: 0; }
		.modelFilterButton { min-width: 40px; height: 22px; display: inline-flex; align-items: center; justify-content: center; margin-right: 4px; padding: 0 6px; border: 1px solid transparent; border-radius: 4px; color: var(--bb-text); background: transparent; font-size: 11.5px; font-weight: 600; }
		.modelFilterButton:hover, .modelFilterButton.active { color: var(--bb-text); border-color: var(--vscode-focusBorder, var(--bb-border)); background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--bb-primary) 10%, transparent)); }
		.providerFilterPane { display: grid; gap: 0; padding: 5px 0 3px; }
		.filterHeader { display: grid; gap: 2px; padding: 4px 10px 5px; }
		.filterTitle { color: var(--bb-text); font-size: 12px; font-weight: 600; line-height: 15px; }
		.filterMeta { color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 11px; line-height: 14px; }
		.providerSwitchList { display: grid; gap: 0; }
		.providerSwitch { width: 100%; min-height: 24px; display: flex; align-items: center; gap: 7px; padding: 0 8px; border: 0; border-radius: 0; color: var(--bb-text); background: transparent; text-align: left; font-size: 12px; }
		.providerSwitch:hover { color: var(--bb-text); background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 8%, transparent)); }
		.providerSwitch.active { color: var(--bb-text); background: transparent; }
		.providerSwitch.focused { background: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 12%, transparent))); color: var(--vscode-list-focusForeground, var(--bb-text)); }
		.providerSwitchIcon { width: 13px; height: 13px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 3px; }
		.providerSwitchName { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.providerSwitchToggle { width: 12px; height: 12px; flex: 0 0 auto; display: grid; place-items: center; order: -1; border: 1px solid var(--bb-border); border-radius: 2px; color: transparent; background: var(--vscode-input-background, transparent); }
		.providerSwitch.active .providerSwitchToggle { color: var(--vscode-focusBorder, var(--bb-primary)); border-color: var(--vscode-focusBorder, var(--bb-primary)); }
		.providerSwitchToggle .codicon { font-size: 10px; }
		.providerFilterDone { min-height: 24px; justify-self: start; margin: 4px 8px 0; padding: 0; color: var(--vscode-textLink-foreground, var(--bb-primary)); background: transparent; font-size: 11.5px; }
		.providerFilterDone:hover { color: var(--vscode-textLink-activeForeground, var(--bb-text)); }
		.modelChoice { min-height: 24px; padding: 0 5px 0 8px; border-radius: 3px; gap: 6px; }
		.modelChoice:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 8%, transparent)); border-color: transparent; }
		.modelChoice.selected { background: var(--vscode-list-focusBackground, color-mix(in srgb, var(--bb-primary) 14%, transparent)); border-color: transparent; color: var(--vscode-list-focusForeground, var(--bb-text)); }
		.modelChoice .choiceIcon { width: 13px; height: 13px; color: var(--vscode-descriptionForeground, var(--bb-muted)); background: transparent; border-radius: 0; }
		.modelChoice .choiceIcon .codicon { font-size: 12px; }
		.modelChoice .choiceMain { display: block; min-width: 0; flex: 1 1 0; }
		.modelChoice .choiceLabel { font-size: 12px; font-weight: 500; line-height: 16px; }
		.modelChoice .choiceMeta { display: none; }
		.modelChoiceMeta { min-width: 0; width: 158px; overflow: hidden; text-overflow: clip; white-space: nowrap; flex: 0 0 158px; color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 10px; line-height: 14px; text-align: right; }
		.modelChoice .codicon-check { width: 12px; flex: 0 0 auto; color: var(--vscode-focusBorder, var(--bb-primary)); font-size: 12px; }
		.modelChoiceCheckSpacer { width: 12px; flex: 0 0 auto; }
		.modelProviderPill { display: none; }
	</style>
	</head>
		<body>
			<div class="root">
				${header}
				${recentTabs}
				<div class="statusBar">
					<div id="runClock" class="runClock" hidden>00:00</div>
					<div id="status" class="status">Ready.</div>
				</div>
				${checkpointStrip}
				<div class="viewStack">
				<div id="log" class="log viewPane active" role="tabpanel" ${logLabel}>
					<div id="emptyState" class="emptyState">
						<div class="emptyIcon" aria-hidden="true"></div>
						<div class="emptyTagline">Ask anything about your code</div>
						<div class="emptyHints">
							<div class="emptyHint">Try: "Explain this function"</div>
							<div class="emptyHint">Try: "Find bugs in my code"</div>
						</div>
					</div>
				</div>
				${historyPane}
				</div>
			${renderComposer()}
				<div id="authOverlay" class="authOverlay" role="dialog" aria-live="polite" aria-label="Connect Your AI">
					<div class="authCard">
						<div class="authLogo" aria-hidden="true"></div>
						<div class="authTitle">Connect Your AI</div>
						<div class="authText">Use Backboard, an API key, or a subscription.</div>
						<button id="authSignInBtn" class="authButton" type="button"><span class="codicon codicon-account"></span><span>Sign In with SSO</span></button>
						<button id="authByokBtn" class="authButton" type="button">Set Up BYOK</button>
						<button id="authByosBtn" class="authButton" type="button">Set Up BYOS</button>
					</div>
				</div>
		</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const root = document.querySelector('.root');
		const log = document.getElementById('log');
		const status = document.getElementById('status');
		const runClock = document.getElementById('runClock');
		const changeStack = document.getElementById('changeStack');
		const queueDock = document.getElementById('queueDock');
		let emptyState = document.getElementById('emptyState');
		const historyPane = document.getElementById('historyPane');
		const historyList = document.getElementById('historyList');
		const historyEmpty = document.getElementById('historyEmpty');
		const historyCount = document.getElementById('historyCount');
		const recentTabs = document.getElementById('recentTabs');
		const inlineHistoryCount = document.getElementById('inlineHistoryCount');
		const inlineNewChatButton = document.getElementById('inlineNewChatBtn');
		const inlineHistoryButton = document.getElementById('inlineHistoryBtn');
		const checkpointStrip = document.getElementById('checkpointStrip');
		const checkpointList = document.getElementById('checkpointList');
			const prompt = document.getElementById('prompt');
			const authSignInButton = document.getElementById('authSignInBtn');
			const toolCount = document.getElementById('toolCount');
		const popover = document.getElementById('popover');
		const popoverTitle = document.getElementById('popoverTitle');
		const popoverBody = document.getElementById('popoverBody');
		const modelIcon = document.getElementById('modelIcon');
		const modelLabel = document.getElementById('modelLabel');
		const modeLabelNode = document.getElementById('modeLabel');
		const headerBadge = document.getElementById('headerBadge');
		const newChatButton = document.getElementById('newChatBtn');
		const buttons = {
			mode: document.getElementById('modeBtn'),
			model: document.getElementById('modelBtn'),
			image: document.getElementById('imageBtn'),
			voice: document.getElementById('voiceBtn'),
			stop: document.getElementById('stopBtn'),
			send: document.getElementById('sendBtn')
		};
		const tabButtons = {
			chat: document.getElementById('chatTab'),
			history: document.getElementById('historyTab')
		};
		const controls = {
			provider: document.getElementById('provider'),
			model: document.getElementById('model'),
			mode: document.getElementById('mode'),
			intensity: document.getElementById('intensity'),
			imageGeneration: document.getElementById('imageGeneration'),
			voiceMode: document.getElementById('voiceMode'),
			mcpFigma: document.getElementById('mcpFigma'),
			mcpNotion: document.getElementById('mcpNotion'),
			mcpGoogle: document.getElementById('mcpGoogle')
		};
		const hostInitialState = ${initialStateJson};
		const hostHasPanelState = !!hostInitialState && typeof hostInitialState === 'object' && (!!hostInitialState.activeHistoryId || !!hostInitialState.promptQueue?.length || !!hostInitialState.historyEntries?.length);
		const persistedState = hostHasPanelState ? hostInitialState : {};
		let models = [];
		let tools = [];
			let settings = {};
			let authenticated = false;
		let activeView = persistedState.activeView === 'history' ? 'history' : 'chat';
		let historyEntries = Array.isArray(persistedState.historyEntries) ? persistedState.historyEntries : [];
		let activeHistoryId = typeof persistedState.activeHistoryId === 'string' ? persistedState.activeHistoryId : undefined;
		function normalizePromptQueue(queue) {
			return Array.isArray(queue) ? queue.map(item => item && typeof item === 'object' ? { ...item, pending: false } : item).filter(Boolean) : [];
		}
		let promptQueue = normalizePromptQueue(persistedState.promptQueue);
		let panelStateSavedAt = typeof persistedState.savedAt === 'number' ? persistedState.savedAt : 0;
		let runInProgress = false;
		let stopRequested = false;
		let activePopover = undefined;
		let activeAnchor = undefined;
		let modelFilter = '';
		let disabledModelProviders = new Set();
		let modelProviderFiltersOpen = false;
		let currentAssistantCard = undefined;
		let currentReasoningCard = undefined;
		let activeToolRows = [];
		let activeToolGroup = undefined;
		let fileChanges = [];
		let latestUsage = undefined;
		let accountUsage = undefined;
		let runStartedAt = undefined;
		let runTimer = undefined;
		let pendingImageFile = undefined;
		let currentPromptClock = undefined;
		let pendingQueuedSendId = undefined;
		let currentWorkspace = typeof persistedState.currentWorkspace === 'string' ? persistedState.currentWorkspace : '';
		let restoringHistory = false;
		let voiceRecorder = undefined;
		let voiceStream = undefined;
		let voiceChunks = [];
		let voiceRecording = false;
		let conversationScrollFrame = undefined;
		let pendingConversationScroll = false;
		let textAppendFrame = undefined;
		const pendingTextAppends = new Map();
		${renderModelSelectScript(iconBase.toString())}
		function modeLabel(value) {
			return ({ agent: 'Agent', ask: 'Ask', manual: 'Manual', free: 'Full Access' })[value] || value;
		}
		function intensityLabel(value) {
			return ({ fast: 'Fast', balanced: 'Balanced', deep: 'Deep' })[value] || value;
		}
		function syncModeLabels() {
			const label = modeLabel(controls.mode.value);
			modeLabelNode.textContent = label;
			headerBadge.textContent = label;
			buttons.mode.title = label + ' / ' + intensityLabel(controls.intensity.value);
			buttons.mode.setAttribute('aria-label', buttons.mode.title);
		}
		function voiceLabel(value) {
			return ({ off: 'Off', tts: 'TTS', stt: 'STT', conversation: 'Conversation' })[value] || value;
		}
		function renderModelPopover() {
			const source = modelSource();
			const query = modelFilter.trim().toLowerCase();
			const allProviders = [...new Set(source.map(model => model.provider))].sort((left, right) => providerDisplayName(left).localeCompare(providerDisplayName(right)));
			const providerFiltered = source.filter(model => !disabledModelProviders.has(model.provider));
			const filtered = query
				? providerFiltered.filter(model => [model.provider, model.displayName, model.name].filter(Boolean).join(' ').toLowerCase().includes(query))
				: providerFiltered;
			const providers = [...new Set(filtered.map(model => model.provider))].sort((left, right) => providerDisplayName(left).localeCompare(providerDisplayName(right)));
			const search = '<div class="modelFilterBar"><input id="modelFilter" class="popoverSearch" type="search" placeholder="Select a model..." value="' + attr(modelFilter) + '" autocomplete="off"><button class="modelFilterButton' + (modelProviderFiltersOpen ? ' active' : '') + '" type="button" data-action="toggleModelProviderFilters" title="Filter by provider" aria-label="Filter by provider" aria-expanded="' + (modelProviderFiltersOpen ? 'true' : 'false') + '">Filter</button></div>';
			const filterWrap = '<div class="modelFilterWrap">' + search + '</div>';
			if (modelProviderFiltersOpen) {
				const allActive = disabledModelProviders.size === 0;
				const allProvidersRow = '<button class="providerSwitch' + (allActive ? ' active' : '') + '" type="button" data-action="setAllProviderFilters" aria-pressed="' + (allActive ? 'true' : 'false') + '"><span class="providerSwitchName">All providers</span><span class="providerSwitchToggle" aria-hidden="true">' + (allActive ? '<span class="codicon codicon-check"></span>' : '') + '</span></button>';
				const providerRows = allProviders.map(provider => providerSwitch(provider, !disabledModelProviders.has(provider))).join('');
				return filterWrap + '<div class="providerFilterPane"><div class="filterHeader"><span class="filterTitle">Filter by provider</span><span class="filterMeta">Choose one or more providers, then press Done.</span></div><div class="providerSwitchList">' + allProvidersRow + providerRows + '</div><button class="providerFilterDone" type="button" data-action="doneModelProviderFilters">Done</button></div>';
			}
			const noModelsMeta = query ? 'Try a different text filter.' : disabledModelProviders.size ? 'Enable a provider filter.' : 'Refresh models or sign in with SSO.';
			const sections = providers.length ? providers.map(provider => {
				const rows = filtered
					.filter(model => model.provider === provider)
					.map(model => modelChoice(model, provider, controls.provider.value === provider && controls.model.value === model.name))
					.join('');
				return section(providerDisplayName(provider), rows);
			}).join('') : section('Models', choice('disabled', '', 'No matching models', noModelsMeta, false, true));
			return filterWrap + sections + '<div class="popoverActions">' + actionButton('refreshModels', 'Refresh Models', 'refresh') + actionButton('signIn', 'SSO', 'account') + '</div>';
		}
		function renderReasoningPopover() {
			const modes = [
				['agent', 'Agent', ''],
				['ask', 'Ask', ''],
				['manual', 'Manual', ''],
				['free', 'Full Access', '']
			].map(([value, label, meta]) => choice('chooseMode', value, label, meta, controls.mode.value === value, false)).join('');
			const intensities = [
				['fast', 'Fast', ''],
				['balanced', 'Balanced', ''],
				['deep', 'Deep', '']
			].map(([value, label, meta]) => choice('chooseIntensity', value, label, meta, controls.intensity.value === value, false)).join('');
			return section('Mode', modes) + section('Reasoning', intensities);
		}
		function renderImagePopover() {
			return section('Image', [
				choice('chooseImage', 'off', 'Off', '', controls.imageGeneration.value === 'off', false),
				choice('chooseImage', 'auto', 'Auto', '', controls.imageGeneration.value === 'auto', false)
			].join(''));
		}
		function renderVoicePopover() {
			return section('Voice', [
				choice('chooseVoice', 'off', 'Off', '', controls.voiceMode.value === 'off', false),
				choice('chooseVoice', 'tts', 'TTS', '', controls.voiceMode.value === 'tts', false),
				choice('chooseVoice', 'stt', 'STT', '', controls.voiceMode.value === 'stt', false),
				choice('chooseVoice', 'conversation', 'Conversation', '', controls.voiceMode.value === 'conversation', false)
			].join(''));
		}
		function renderUsagePopover() {
			const refresh = '<div class="popoverActions">' + actionButton('refreshUsage', 'Refresh Usage', 'refresh') + '</div>';
			if (!latestUsage && !accountUsage) {
				return section('Usage', choice('disabled', '', 'No usage yet', 'Refresh billing usage or run a Backboard turn.', false, true, '', 'pulse')) + refresh;
			}
			const account = accountUsage
				? section('Account', choice('disabled', '', 'Billing usage', accountUsage.summary, false, true, '', 'pulse') + accountUsage.metrics.map(([label, value]) => choice('disabled', '', label, value, false, true, '', 'dashboard')).join(''))
				: '';
			if (!latestUsage) {
				return account + refresh;
			}
			const summary = section('Latest Run', choice('disabled', '', 'Latest run', latestUsage.summary, false, true, '', 'pulse'));
			const metrics = latestUsage.metrics.length
				? latestUsage.metrics.map(([label, value]) => choice('disabled', '', label, value, false, true, '', 'dashboard')).join('')
				: choice('disabled', '', 'Usage details', 'No metric fields were reported.', false, true, '', 'dashboard');
			return account + summary + section('Metrics', metrics) + refresh;
		}
		function renderPopover(name) {
			const renderers = {
				model: ['Model', renderModelPopover],
				reasoning: ['Mode and Reasoning', renderReasoningPopover],
				image: ['Image', renderImagePopover],
				voice: ['Voice', renderVoicePopover]
			};
			const renderer = renderers[name] || renderers.model;
			popover.dataset.kind = name;
			popoverTitle.textContent = renderer[0];
			popoverBody.innerHTML = renderer[1]();
		}
		function positionPopover(anchorButton) {
			const width = Math.min(620, window.innerWidth - 8);
			popover.style.width = width + 'px';
			const rect = anchorButton.getBoundingClientRect();
			const popoverRect = popover.getBoundingClientRect();
			const left = Math.max(4, Math.min(window.innerWidth - popoverRect.width - 4, rect.left + rect.width / 2 - popoverRect.width / 2));
			const top = Math.max(4, rect.top - popoverRect.height - 4);
			popover.style.left = left + 'px';
			popover.style.top = top + 'px';
		}
		function openPopover(name, anchorButton) {
			if (activePopover === name && popover.classList.contains('open')) {
				closePopover();
				return;
			}
			if (name === 'model') {
				modelFilter = '';
				disabledModelProviders.clear();
				modelProviderFiltersOpen = false;
			}
			activePopover = name;
			activeAnchor = anchorButton;
			renderPopover(name);
			popover.classList.add('open');
			popover.setAttribute('aria-hidden', 'false');
			positionPopover(anchorButton);
			syncComposerButtons();
		}
		function closePopover() {
			activePopover = undefined;
			activeAnchor = undefined;
			popover.classList.remove('open');
			popover.setAttribute('aria-hidden', 'true');
			popoverBody.textContent = '';
			modelFilter = '';
			disabledModelProviders.clear();
			modelProviderFiltersOpen = false;
			prompt.focus();
			syncComposerButtons();
		}
		function requestUsageSnapshot() {
			updateStatus('Loading Backboard usage.');
			vscode.postMessage({ type: 'refreshUsage' });
		}
		function chooseSelect(select, value, close) {
			setSelect(select, value);
			select.dispatchEvent(new Event('change'));
			if (close) {
				closePopover();
			} else if (activePopover) {
				renderPopover(activePopover);
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			}
		}
		function renderModels() {
			const source = modelSource();
			const providers = [...new Set(source.map(model => model.provider))].sort((left, right) => providerDisplayName(left).localeCompare(providerDisplayName(right)));
			controls.provider.textContent = '';
			const fallbackProvider = source[0]?.provider || settings.provider || 'aws-bedrock';
			for (const provider of providers.length ? providers : [fallbackProvider]) {
				const option = document.createElement('option');
				option.value = provider;
				option.textContent = providerDisplayName(provider);
				controls.provider.appendChild(option);
			}
			setSelect(controls.provider, settings.provider || '');
			let provider = controls.provider.value || fallbackProvider;
			if (!providers.includes(provider) && source[0]) {
				provider = source[0].provider;
				controls.provider.value = provider;
			}
			const providerModels = source.filter(model => model.provider === provider);
			controls.model.textContent = '';
			const selectableModels = providerModels.length ? providerModels : [{ provider, name: settings.model || 'anthropic.claude-sonnet-4-6', displayName: settings.model || 'anthropic.claude-sonnet-4-6' }];
			for (const model of selectableModels) {
				const option = document.createElement('option');
				option.value = model.name;
				option.textContent = [providerDisplayName(provider), model.displayName || model.name].filter(Boolean).join(' / ');
				option.title = [providerDisplayName(provider), model.name, model.contextLimit ? model.contextLimit + ' tokens' : '', model.supportsThinking ? 'thinking' : ''].filter(Boolean).join(' / ');
				controls.model.appendChild(option);
			}
			setSelect(controls.model, settings.model || '');
			if (!selectableModels.some(model => model.name === controls.model.value) && selectableModels[0]) {
				controls.model.value = selectableModels[0].name;
			}
			settings.provider = controls.provider.value || provider;
			settings.model = controls.model.value || selectableModels[0]?.name || settings.model;
			const selected = source.find(model => model.provider === provider && model.name === controls.model.value);
			modelLabel.textContent = selected?.displayName || selected?.name || controls.model.value || 'Auto';
			modelIcon.innerHTML = unwrapModelIconHtml(providerIconHtml(provider, 'modelIcon'));
			buttons.model.title = currentModelLabel();
		}
			function applySettings(next) {
				settings = { ...settings, ...(next || {}) };
				setAuthenticated(settings.authenticated === true);
				renderModels();
			setSelect(controls.mode, settings.mode || 'free');
			setSelect(controls.intensity, settings.intensity || 'fast');
			setSelect(controls.imageGeneration, settings.imageGeneration || 'off');
			setSelect(controls.voiceMode, settings.voiceMode || 'off');
			controls.mcpFigma.checked = !!settings.mcpFigma;
			controls.mcpNotion.checked = !!settings.mcpNotion;
			controls.mcpGoogle.checked = !!settings.mcpGoogle;
			syncModeLabels();
			const selected = modelSource().find(model => model.provider === controls.provider.value && model.name === controls.model.value);
			modelLabel.textContent = selected?.displayName || selected?.name || controls.model.value || 'Auto';
			syncComposerButtons();
		}
		for (const control of Object.values(controls)) {
			control.addEventListener('change', () => {
				if (control === controls.provider) {
					settings.provider = controls.provider.value;
					const first = modelSource().find(model => model.provider === settings.provider);
					if (first) {
						settings.model = first.name;
					}
					renderModels();
				}
				if (control === controls.mode || control === controls.intensity) {
					syncModeLabels();
				}
				if (control === controls.mode) {
					vscode.postMessage({ type: 'refreshModels' });
				}
				saveOptions();
				syncComposerButtons();
			});
		}
			prompt.addEventListener('input', syncComposerButtons);
			authSignInButton?.addEventListener('click', () => {
				vscode.postMessage({ type: 'signIn' });
			});
			document.getElementById('authByokBtn')?.addEventListener('click', () => {
				vscode.postMessage({ type: 'setupProviderKey' });
			});
			document.getElementById('authByosBtn')?.addEventListener('click', () => {
				vscode.postMessage({ type: 'setupSubscription' });
			});
		prompt.addEventListener('keydown', event => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault();
				document.getElementById('form').requestSubmit();
			}
		});
		prompt.addEventListener('paste', event => {
			const clipboardItems = event.clipboardData?.items;
			if (!clipboardItems) {
				return;
			}
			for (let idx = 0; idx < clipboardItems.length; idx++) {
				const item = clipboardItems[idx];
				if (item.type.startsWith('image/')) {
					event.preventDefault();
					const blob = item.getAsFile();
					if (!blob) {
						continue;
					}
					const reader = new FileReader();
					reader.onload = () => {
						const arrayBuffer = reader.result;
						if (!(arrayBuffer instanceof ArrayBuffer)) {
							return;
						}
						pendingImageFile = {
							data: Array.from(new Uint8Array(arrayBuffer)),
							fileName: blob.name || 'pasted-image.' + (item.type.split('/')[1] || 'png'),
							mimeType: item.type,
						};
						updateStatus('Image attached. Submit to send.');
					};
					reader.readAsArrayBuffer(blob);
					break;
				}
			}
		});
		buttons.mode.addEventListener('click', event => openPopover('reasoning', event.currentTarget));
		buttons.model.addEventListener('click', event => openPopover('model', event.currentTarget));
		buttons.image.addEventListener('click', event => openPopover('image', event.currentTarget));
		buttons.voice.addEventListener('click', event => {
			if (voiceRecording || controls.voiceMode.value === 'stt' || controls.voiceMode.value === 'conversation') {
				void toggleVoiceCapture();
				return;
			}
			openPopover('voice', event.currentTarget);
		});
		buttons.stop.addEventListener('click', () => {
			if (!runInProgress) {
				return;
			}
			stopRequested = true;
			closePopover();
			updateStatus('Stopping Backboard.');
			vscode.postMessage({ type: 'cancel' });
			syncComposerButtons();
		});
		newChatButton?.addEventListener('click', startNewChat);
		inlineNewChatButton?.addEventListener('click', startNewChat);
		inlineHistoryButton?.addEventListener('click', () => setActiveView(activeView === 'history' ? 'chat' : 'history'));
		tabButtons.chat?.addEventListener('click', () => setActiveView('chat'));
		tabButtons.history?.addEventListener('click', () => setActiveView('history'));
		historyList?.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target.closest('[data-history-id]') : undefined;
			if (target) {
				restoreHistoryEntry(target.dataset.historyId || '');
			}
		});
		recentTabs?.addEventListener('click', event => {
			const eventTarget = event.target;
			const target = eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined;
			const closeTarget = target?.closest('[data-close-history-id]');
			if (closeTarget) {
				event.stopPropagation();
				closeHistoryEntry(closeTarget.dataset.closeHistoryId || '');
				return;
			}
			const tabTarget = target?.closest('[data-history-id]');
			if (tabTarget) {
				restoreHistoryEntry(tabTarget.dataset.historyId || '');
			}
		});
		recentTabs?.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') {
				return;
			}
			const eventTarget = event.target;
			const target = eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined;
			if (target?.closest('[data-close-history-id]')) {
				return;
			}
			const tabTarget = target?.closest('[data-history-id]');
			if (tabTarget) {
				event.preventDefault();
				restoreHistoryEntry(tabTarget.dataset.historyId || '');
			}
		});
		checkpointList?.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target.closest('[data-checkpoint-id]') : undefined;
			if (target) {
				restoreCheckpoint(target.dataset.checkpointId || '');
			}
		});
		changeStack?.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target.closest('[data-log-action]') : undefined;
			const action = target?.getAttribute('data-log-action');
			if (action === 'reviewChanges') {
				vscode.postMessage({ type: 'reviewChanges' });
			}
		});
		log.addEventListener('click', event => {
			const groupToggle = event.target instanceof Element ? event.target.closest('[data-tool-group-toggle]') : undefined;
			if (groupToggle) {
				const group = groupToggle.closest('.toolGroup');
				if (group instanceof HTMLElement) {
					const open = group.classList.toggle('open');
					groupToggle.title = open ? 'Hide command list' : 'Show command list';
					groupToggle.setAttribute('aria-label', groupToggle.title);
					updateToolGroupSummary(group);
				}
				return;
			}
			const toolToggle = event.target instanceof Element ? event.target.closest('[data-tool-toggle]') : undefined;
			if (toolToggle) {
				const row = toolToggle.closest('.toolCard');
				if (row instanceof HTMLElement) {
					const open = row.classList.toggle('open');
					toolToggle.title = open ? 'Hide tool details' : 'Show tool details';
					toolToggle.setAttribute('aria-label', toolToggle.title);
					toolToggle.textContent = '';
					toolToggle.appendChild(icon(open ? 'chevron-up' : 'chevron-down'));
				}
				return;
			}
			const target = event.target instanceof Element ? event.target.closest('[data-log-action]') : undefined;
			const action = target?.getAttribute('data-log-action');
			if (action === 'reviewChanges') {
				vscode.postMessage({ type: 'reviewChanges' });
				return;
			}
			if (action === 'editPrompt' || action === 'queuePrompt') {
				const card = target?.closest('.messageCard.user');
				const text = card?.querySelector('.messageText')?.textContent || '';
				if (action === 'editPrompt') {
					prompt.value = text;
					prompt.focus();
					prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
					syncComposerButtons();
					updateStatus('Prompt loaded for editing.');
				} else {
					queuePrompt(text, options());
				}
				return;
			}
			const queueTarget = event.target instanceof Element ? event.target.closest('[data-queue-action]') : undefined;
			if (queueTarget) {
				const card = queueTarget.closest('[data-queue-id]');
				const queueId = card?.getAttribute('data-queue-id') || '';
				const action = queueTarget.getAttribute('data-queue-action');
				const index = promptQueue.findIndex(item => item.id === queueId);
				if (index < 0) {
					return;
				}
				if (action === 'remove') {
					promptQueue.splice(index, 1);
				} else if (action === 'run') {
					const item = promptQueue[index];
					if (runInProgress) {
						updateStatus('Wait for the current Backboard turn to finish, then run the queued prompt.');
					} else if (item?.text?.trim()) {
						pendingQueuedSendId = item.id;
						item.pending = true;
						sendPromptToHost(item.text.trim(), item.options || options());
					}
				}
				renderQueue();
				saveActiveHistory();
			}
		});
		queueDock?.addEventListener('click', event => {
			const queueTarget = event.target instanceof Element ? event.target.closest('[data-queue-action]') : undefined;
			if (!queueTarget) {
				return;
			}
			const card = queueTarget.closest('[data-queue-id]');
			const queueId = card?.getAttribute('data-queue-id') || '';
			const action = queueTarget.getAttribute('data-queue-action');
			const index = promptQueue.findIndex(item => item.id === queueId);
			if (index < 0) {
				return;
			}
			if (action === 'remove') {
				promptQueue.splice(index, 1);
			} else if (action === 'run') {
				const item = promptQueue[index];
				if (runInProgress) {
					updateStatus('Wait for the current Backboard turn to finish, then run the queued prompt.');
				} else if (item?.text?.trim()) {
					pendingQueuedSendId = item.id;
					item.pending = true;
					sendPromptToHost(item.text.trim(), item.options || options());
				}
			}
			renderQueue();
			saveActiveHistory();
		});
		document.getElementById('popoverClose').addEventListener('click', closePopover);
		popoverBody.addEventListener('input', event => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement) || target.id !== 'modelFilter') {
				return;
			}
			modelFilter = target.value;
			renderPopover('model');
			if (activeAnchor) {
				positionPopover(activeAnchor);
			}
			const filter = document.getElementById('modelFilter');
			if (filter instanceof HTMLInputElement) {
				filter.focus();
				filter.setSelectionRange(filter.value.length, filter.value.length);
			}
		});
		popoverBody.addEventListener('click', event => {
			const eventTarget = event.target;
			const target = (eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined
				)?.closest('[data-action]');
			if (!target || target.classList.contains('disabled')) {
				return;
			}
			event.stopPropagation();
			const action = target.dataset.action;
			const value = target.dataset.value || '';
			if (action === 'insertContextType') {
				insertAtCursor('@' + value + ' ');
				closePopover();
			} else if (action === 'insertActiveFile') {
				vscode.postMessage({ type: 'insertActiveFile' });
				closePopover();
			} else if (action === 'insertSelection') {
				vscode.postMessage({ type: 'insertSelection' });
				closePopover();
			} else if (action === 'insertBranchDiff') {
				vscode.postMessage({ type: 'insertBranchDiff' });
				closePopover();
			} else if (action === 'chooseMode') {
				chooseSelect(controls.mode, value, false);
			} else if (action === 'chooseIntensity') {
				chooseSelect(controls.intensity, value, false);
			} else if (action === 'chooseImage') {
				chooseSelect(controls.imageGeneration, value, true);
			} else if (action === 'chooseVoice') {
				chooseSelect(controls.voiceMode, value, true);
				if (value === 'stt' || value === 'conversation') {
					void toggleVoiceCapture();
				}
			} else if (action === 'toggleProviderFilter') {
				const provider = target.dataset.provider || value;
				if (disabledModelProviders.has(provider)) {
					disabledModelProviders.delete(provider);
				} else {
					disabledModelProviders.add(provider);
				}
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'setAllProviderFilters') {
				disabledModelProviders.clear();
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'toggleModelProviderFilters') {
				modelProviderFiltersOpen = !modelProviderFiltersOpen;
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'doneModelProviderFilters') {
				modelProviderFiltersOpen = false;
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'chooseModel') {
				const provider = target.dataset.provider || controls.provider.value;
				const model = target.dataset.model || value;
				setSelect(controls.provider, provider);
				renderModels();
				setSelect(controls.model, model);
				settings.provider = provider;
				settings.model = model;
				const selected = modelSource().find(item => item.provider === provider && item.name === model);
				modelLabel.textContent = selected?.displayName || selected?.name || model;
				saveOptions();
				closePopover();
			} else if (action === 'refreshModels') {
				vscode.postMessage({ type: 'refreshModels' });
				closePopover();
			} else if (action === 'refreshUsage') {
				requestUsageSnapshot();
			} else if (action === 'setApiKey' || action === 'signIn') {
				vscode.postMessage({ type: 'signIn' });
				closePopover();
			} else if (action === 'openModel') {
				openPopover('model', buttons.model);
			} else if (action === 'openReasoning') {
				openPopover('reasoning', buttons.mode);
			} else if (action === 'openImage') {
				openPopover('image', buttons.image);
			} else if (action === 'cancelRun') {
				vscode.postMessage({ type: 'cancel' });
				closePopover();
			}
		});
		document.addEventListener('pointerdown', event => {
			if (!activePopover) {
				return;
			}
			const eventTarget = event.target;
			const target = eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined;
			if (!target) {
				return;
			}
			if (popover.contains(target) || activeAnchor?.contains(target)) {
				return;
			}
			closePopover();
		}, true);
		document.addEventListener('error', event => {
			const target = event.target;
			if (!(target instanceof HTMLImageElement) || target.dataset.providerIcon !== 'true') {
				return;
			}
			const fallback = document.createElement('span');
			fallback.className = 'codicon codicon-symbol-misc';
			target.replaceWith(fallback);
		}, true);
		document.addEventListener('keydown', event => {
			if (event.key === 'Escape' && activePopover) {
				event.preventDefault();
				closePopover();
			}
		});
		window.addEventListener('resize', () => {
			syncRootHeight();
			if (activePopover && activeAnchor) {
				positionPopover(activeAnchor);
			}
		});
		window.visualViewport?.addEventListener('resize', syncRootHeight);
			document.getElementById('form').addEventListener('submit', event => {
				event.preventDefault();
				if (!authenticated) {
					updateStatus('Sign in required.');
					authSignInButton?.focus();
					return;
				}
				const text = prompt.value.trim();
			if (!text) {
				syncComposerButtons();
				return;
			}
			if (text === '/retry') {
				retryLastPrompt();
				prompt.value = '';
				syncComposerButtons();
				return;
			}
			if (runInProgress) {
				queuePrompt(text, options());
			} else {
				sendPromptToHost(text, options());
			}
			prompt.value = '';
			syncComposerButtons();
		});
		function isNearConversationBottom() {
			return log.scrollHeight - log.scrollTop - log.clientHeight < 96;
		}
		function scrollConversation(force) {
			const shouldStick = force || runInProgress || isNearConversationBottom();
			syncEmptyState();
			scheduleActiveHistorySave();
			if (!shouldStick) {
				return;
			}
			pendingConversationScroll = true;
			if (conversationScrollFrame === undefined) {
				conversationScrollFrame = requestAnimationFrame(() => {
					conversationScrollFrame = undefined;
					if (!pendingConversationScroll) {
						return;
					}
					pendingConversationScroll = false;
					log.scrollTop = log.scrollHeight;
				});
			}
		}
		function flushPendingTextAppends() {
			if (textAppendFrame !== undefined) {
				cancelAnimationFrame(textAppendFrame);
				textAppendFrame = undefined;
			}
			if (!pendingTextAppends.size) {
				return false;
			}
			for (const [target, text] of pendingTextAppends) {
				let textNode = target.lastChild;
				if (!(textNode instanceof Text)) {
					textNode = document.createTextNode('');
					target.appendChild(textNode);
				}
				textNode.appendData(text);
			}
			pendingTextAppends.clear();
			return true;
		}
		function queueTextAppend(target, text) {
			if (!text) {
				return;
			}
			pendingTextAppends.set(target, (pendingTextAppends.get(target) || '') + text);
			if (textAppendFrame === undefined) {
				textAppendFrame = requestAnimationFrame(() => {
					textAppendFrame = undefined;
					if (flushPendingTextAppends()) {
						scrollConversation();
					}
				});
			}
		}
		function clearConversation() {
			saveActiveHistory();
			log.textContent = '';
			log.appendChild(ensureEmptyState());
			currentAssistantCard = undefined;
			currentReasoningCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			fileChanges = [];
			promptQueue = [];
			latestUsage = undefined;
			activeHistoryId = undefined;
			runInProgress = false;
			stopRequested = false;
			stopRunTimer();
			syncComposerButtons();
			renderChangeStack();
			renderRecentTabs();
			renderCheckpoints();
			scrollConversation(true);
		}
		function queuePrompt(text, queuedOptions) {
			const value = String(text || '').trim();
			if (!value) {
				return;
			}
			promptQueue.push({
				id: 'queued-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
				text: value,
				options: queuedOptions || options(),
				createdAt: Date.now()
			});
			renderQueue();
			saveActiveHistory();
			updateStatus(promptQueue.length + ' queued prompt' + (promptQueue.length === 1 ? '' : 's') + '.');
		}
		function latestUserPrompt() {
			const messages = Array.from(log.querySelectorAll('.messageCard.user .messageText'));
			for (let index = messages.length - 1; index >= 0; index--) {
				const value = messages[index].textContent?.trim();
				if (value && value !== '/retry') {
					return value;
				}
			}
			const entry = activeHistoryEntry();
			return entry?.prompt?.trim() || '';
		}
		function retryLastPrompt() {
			const text = latestUserPrompt();
			if (!text) {
				updateStatus('No previous prompt to retry.');
				return;
			}
			if (runInProgress) {
				queuePrompt(text, options());
			} else {
				sendPromptToHost(text, options());
			}
		}
		function renderQueue() {
			document.querySelectorAll('#queueBlock').forEach(node => node.remove());
			const dock = document.getElementById('queueDock');
			dock?.classList.toggle('visible', promptQueue.length > 0);
			if (!promptQueue.length) {
				persistPanelState();
				return;
			}
			const block = document.createElement('div');
			block.id = 'queueBlock';
			block.className = 'queueBlock';
			const header = document.createElement('div');
			header.className = 'queueHeader';
			const title = document.createElement('span');
			title.className = 'queueTitle';
			title.append(icon('git-pull-request-go-to-changes'));
			const label = document.createElement('span');
			label.textContent = promptQueue.length + ' queued';
			title.appendChild(label);
			const hint = document.createElement('span');
			hint.className = 'queueHint';
			hint.textContent = runInProgress ? 'Ready after this turn' : 'Press Run to send';
			header.append(title, hint);
			block.appendChild(header);
			for (const item of promptQueue) {
				const card = document.createElement('div');
				card.className = 'queueCard';
				card.dataset.queueId = item.id;
				const editor = document.createElement('textarea');
				editor.className = 'queueTextarea';
				editor.value = item.text || '';
				editor.setAttribute('aria-label', 'Queued prompt');
				editor.addEventListener('input', () => {
					item.text = editor.value;
					saveActiveHistory();
				});
				const actions = document.createElement('div');
				actions.className = 'queueActions';
				const run = document.createElement('button');
				run.className = 'queueButton primary';
				run.type = 'button';
				run.dataset.queueAction = 'run';
				run.textContent = item.pending ? 'Starting...' : 'Run';
				run.disabled = runInProgress || !!item.pending;
				run.title = item.pending ? 'Starting this queued prompt' : runInProgress ? 'Available after the current turn finishes' : 'Run queued prompt';
				const remove = document.createElement('button');
				remove.className = 'queueButton';
				remove.type = 'button';
				remove.dataset.queueAction = 'remove';
				remove.textContent = 'Remove';
				remove.disabled = !!item.pending;
				actions.append(run, remove);
				card.append(editor, actions);
				block.appendChild(card);
			}
			(dock || log).appendChild(block);
		}
			function sendPromptToHost(text, queuedOptions) {
				detachActiveHistoryIfWorkspaceChanged();
				const chatId = beginHistoryRun(text);
				runInProgress = true;
				const imageFile = pendingImageFile;
				pendingImageFile = undefined;
			startRunTimer(Date.now());
			renderQueue();
					vscode.postMessage({ type: 'send', chatId, prompt: text, workspace: resolvedCurrentWorkspace() || undefined, options: queuedOptions || options(), imageFile });
			}
		function drainPromptQueue() {
			renderQueue();
		}
		function icon(name) {
			const span = document.createElement('span');
			span.className = 'codicon codicon-' + name;
			return span;
		}
		function latestTranscriptNode() {
			const children = Array.from(log.children);
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index];
				if (child !== emptyState) {
					return child;
				}
			}
			return undefined;
		}
		function breakAssistantStream() {
			currentAssistantCard = undefined;
			currentReasoningCard = undefined;
		}
		function appendReasoningMessage(text) {
			const card = document.createElement('details');
			card.className = 'messageCard reasoning';
			card.open = true;
			const summary = document.createElement('summary');
			summary.textContent = 'Thinking';
			const body = document.createElement('div');
			body.className = 'reasoningText';
			body.textContent = text || '';
			card.append(summary, body);
			log.appendChild(card);
			currentAssistantCard = undefined;
			currentReasoningCard = card;
			scrollConversation();
			return body;
		}
			function appendMessage(role, text) {
				if (role === 'reasoning') {
					return appendReasoningMessage(text);
				}
				const card = document.createElement('div');
				card.className = 'messageCard ' + role;
				const body = document.createElement('div');
				body.className = 'messageText';
				body.textContent = text || '';
				card.appendChild(body);
				if (role === 'user') {
					if (runInProgress && runStartedAt !== undefined) {
						const meta = document.createElement('div');
						meta.className = 'messageMeta';
						meta.textContent = formatElapsed(Date.now() - runStartedAt);
						meta.title = 'Prompt running';
						card.appendChild(meta);
						currentPromptClock = meta;
					}
					const actions = document.createElement('div');
					actions.className = 'messageActions';
					const edit = document.createElement('button');
					edit.className = 'messageAction';
					edit.type = 'button';
					edit.title = 'Edit prompt';
					edit.dataset.logAction = 'editPrompt';
					edit.appendChild(icon('edit'));
					const rerun = document.createElement('button');
					rerun.className = 'messageAction';
					rerun.type = 'button';
					rerun.title = 'Queue again';
					rerun.dataset.logAction = 'queuePrompt';
					rerun.appendChild(icon('debug-rerun'));
					actions.append(edit, rerun);
					card.appendChild(actions);
				}
				log.appendChild(card);
				if (role === 'assistant') {
					currentAssistantCard = card;
					currentReasoningCard = undefined;
				}
			scrollConversation();
			return body;
		}
		function appendStatus(text, kind) {
			breakAssistantStream();
			const row = document.createElement('div');
			row.className = 'statusRow ' + (kind || '');
			const marker = document.createElement('span');
			marker.className = 'statusIcon';
			marker.appendChild(icon(kind === 'error' ? 'error' : kind === 'muted' ? 'info' : 'check'));
			const label = document.createElement('span');
			label.textContent = text || '';
			row.append(marker, label);
			log.appendChild(row);
			scrollConversation();
			return row;
		}
		function toolStatusLabel(status) {
			return ({ started: 'Running', finished: 'Finished', failed: 'Failed', denied: 'Denied' })[status] || 'Updated';
		}
		function toolStatusIconName(status) {
			return status === 'failed' || status === 'denied' ? 'error' : status === 'started' ? 'sync' : 'check';
		}
		function toolPrimaryDetail(item) {
			const args = item?.args || {};
			if (typeof args.command === 'string' || typeof args.cmd === 'string') {
				return args.command || args.cmd;
			}
			if (typeof args.path === 'string' || typeof args.file_path === 'string' || typeof args.filePath === 'string') {
				return args.path || args.file_path || args.filePath;
			}
			if (typeof args.pattern === 'string') {
				return args.pattern;
			}
			if (typeof item?.error === 'string') {
				return item.error;
			}
			const output = item?.output;
			return typeof output === 'string' ? output : '';
		}
		function toolDetailsText(item) {
			const parts = [];
			if (item?.args && Object.keys(item.args).length) {
				parts.push('Input\\n' + JSON.stringify(item.args, null, 2));
			}
			if (item?.output !== undefined) {
				parts.push('Output\\n' + (typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2)));
			}
			if (item?.error) {
				parts.push('Error\\n' + String(item.error));
			}
			return parts.join('\\n\\n');
		}
		function clippedToolText(value) {
			const text = String(value || '');
			const max = 12000;
			return text.length > max ? text.slice(0, max) + '\\n\\n[truncated]' : text;
		}
		function toolGroupParts(group) {
			return {
				status: group?.querySelector('.toolGroupStatus'),
				title: group?.querySelector('.toolGroupTitle'),
				meta: group?.querySelector('.toolGroupMeta'),
				toggle: group?.querySelector('.toolGroupToggle')
			};
		}
		function setIcon(element, name) {
			if (!element) {
				return;
			}
			element.textContent = '';
			element.appendChild(icon(name));
		}
		function updateToolGroupSummary(group) {
			if (!(group instanceof HTMLElement)) {
				return;
			}
			const cards = Array.from(group.querySelectorAll('.toolCard'));
			const running = cards.filter(card => card.classList.contains('started')).length;
			const failed = cards.filter(card => card.classList.contains('failed') || card.classList.contains('denied')).length;
			const total = cards.length;
			const parts = toolGroupParts(group);
			group.classList.toggle('running', running > 0);
			group.classList.toggle('failed', failed > 0);
			if (parts.title) {
				parts.title.textContent = running > 0 ? 'Running commands' : failed > 0 ? 'Finished with errors' : 'Finished commands';
			}
			if (parts.meta) {
				const chunks = [total + ' command' + (total === 1 ? '' : 's')];
				if (running > 0) {
					chunks.push(running + ' running');
				}
				if (failed > 0) {
					chunks.push(failed + ' failed');
				}
				parts.meta.textContent = chunks.join(', ');
			}
			setIcon(parts.status, failed > 0 ? 'error' : running > 0 ? 'sync' : 'check');
			setIcon(parts.toggle, group.classList.contains('open') ? 'chevron-up' : 'chevron-down');
		}
		function ensureToolGroup() {
			if (activeToolGroup?.row?.isConnected) {
				return activeToolGroup;
			}
			const row = document.createElement('div');
			row.className = 'toolGroup running';
			const head = document.createElement('button');
			head.className = 'toolGroupHead';
			head.type = 'button';
			head.dataset.toolGroupToggle = 'true';
			head.title = 'Show command list';
			head.setAttribute('aria-label', 'Show command list');
			const status = document.createElement('span');
			status.className = 'toolGroupStatus';
			const main = document.createElement('span');
			main.className = 'toolGroupMain';
			const title = document.createElement('span');
			title.className = 'toolGroupTitle';
			const meta = document.createElement('span');
			meta.className = 'toolGroupMeta';
			const toggle = document.createElement('span');
			toggle.className = 'toolGroupToggle';
			main.append(title, meta);
			head.append(status, main, toggle);
			const body = document.createElement('div');
			body.className = 'toolGroupBody';
			row.append(head, body);
			log.appendChild(row);
			activeToolGroup = { row, body };
			updateToolGroupSummary(row);
			return activeToolGroup;
		}
		function closeActiveToolGroup(finalStatus) {
			for (const item of activeToolRows) {
				if (item?.row instanceof HTMLElement && item.row.classList.contains('started')) {
					item.row.classList.remove('started');
					item.row.classList.add(finalStatus === 'failed' ? 'failed' : 'finished');
					const statusIcon = item.row.querySelector('.toolStatusIcon');
					setIcon(statusIcon, finalStatus === 'failed' ? 'error' : 'check');
					if (item.label) {
						item.label.textContent = (finalStatus === 'failed' ? 'Failed ' : 'Finished ') + item.name;
					}
				}
			}
			if (activeToolGroup?.row) {
				updateToolGroupSummary(activeToolGroup.row);
			}
			activeToolRows = [];
			activeToolGroup = undefined;
		}
		function appendToolOutput(payload) {
			const key = payload?.key;
			const text = typeof payload?.text === 'string' ? payload.text : '';
			if (!key || !text) {
				return;
			}
			const row = log.querySelector('.toolCard[data-tool-key="' + CSS.escape(String(key)) + '"]');
			const details = row?.querySelector('.toolDetails');
			if (!(details instanceof HTMLElement)) {
				return;
			}
			const current = details.textContent === 'No details reported.' ? '' : details.textContent || '';
			details.textContent = clippedToolText(current + text);
			row.classList.add('hasTerminal');
			const meta = row.querySelector('.toolMeta');
			if (meta && text.trim()) {
				meta.textContent = text.trim().split(/\\r?\\n/).pop()?.slice(0, 220) || meta.textContent;
			}
			updateToolGroupSummary(row.closest('.toolGroup'));
			scrollConversation();
		}
		function appendTool(item) {
			breakAssistantStream();
			const status = item?.status || 'updated';
			const name = item?.name || 'tool';
			const key = item?.key || toolKey(item);
			if (status === 'failed' || status === 'denied') {
				console.error('[Backboard tool failure]', {
					status,
					name,
					key,
					args: item?.args,
					error: item?.error,
					output: item?.output
				});
			}
			let existingIndex = -1;
			for (let index = activeToolRows.length - 1; index >= 0; index--) {
				if (activeToolRows[index].key === key) {
					existingIndex = index;
					break;
				}
			}
			if (existingIndex < 0 && status !== 'started') {
				for (let index = activeToolRows.length - 1; index >= 0; index--) {
					if (activeToolRows[index].name === name) {
						existingIndex = index;
						break;
					}
				}
			}
			const existing = existingIndex >= 0 ? activeToolRows[existingIndex] : undefined;
			const row = existing ? existing.row : document.createElement('div');
			const startedAt = existing?.startedAt ?? Date.now();
			const detail = toolPrimaryDetail(item);
			const details = toolDetailsText(item);
			row.className = 'toolCard ' + status;
			row.dataset.toolKey = String(key);
			row.textContent = '';
			const head = document.createElement('div');
			head.className = 'toolHead';
			const statusIcon = document.createElement('span');
			statusIcon.className = 'toolStatusIcon';
			statusIcon.appendChild(icon(toolStatusIconName(status)));
			const main = document.createElement('span');
			main.className = 'toolMain';
			const label = document.createElement('span');
			label.className = 'toolLabel';
			label.textContent = toolStatusLabel(status) + ' ' + name;
			const meta = document.createElement('span');
			meta.className = 'toolMeta';
			meta.textContent = detail || (details ? 'View details' : 'Local Backboard tool');
			main.append(label, meta);
			const duration = document.createElement('span');
			duration.className = 'toolDuration';
			duration.textContent = status === 'started' ? formatElapsed(Date.now() - startedAt) : existing?.duration?.textContent || formatElapsed(Date.now() - startedAt);
			const toggle = document.createElement('button');
			toggle.className = 'toolToggle';
			toggle.type = 'button';
			toggle.dataset.toolToggle = 'true';
			toggle.title = 'Show tool details';
			toggle.setAttribute('aria-label', 'Show tool details');
			toggle.appendChild(icon('chevron-down'));
			head.append(statusIcon, main, duration, toggle);
			const body = document.createElement('pre');
			body.className = 'toolDetails';
			const previousDetails = existing?.row?.querySelector('.toolDetails')?.textContent;
			body.textContent = clippedToolText(details || previousDetails || 'No details reported.');
			row.append(head, body);
			if (existingIndex >= 0) {
				activeToolRows.splice(existingIndex, 1);
			} else {
				ensureToolGroup().body.appendChild(row);
			}
			if (status === 'started') {
				activeToolRows.push({ key, name, row, label, duration, startedAt });
			}
			updateToolGroupSummary(row.closest('.toolGroup'));
			scrollConversation();
		}
		function numberValue(value) {
			if (typeof value === 'number' && Number.isFinite(value)) {
				return value;
			}
			if (typeof value === 'string' && value.trim() !== '') {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : undefined;
			}
			return undefined;
		}
		function firstNumber(source, names) {
			for (const name of names) {
				const value = numberValue(source?.[name]);
				if (value !== undefined) {
					return value;
				}
			}
			return undefined;
		}
		function firstString(source, names) {
			for (const name of names) {
				const value = source?.[name];
				if (typeof value === 'string' && value.trim()) {
					return value.trim();
				}
			}
			return undefined;
		}
		function formatNumber(value) {
			return value === undefined ? undefined : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
		}
		function formatPercent(value) {
			return value === undefined ? undefined : new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 1 ? 2 : 1 }).format(value) + '%';
		}
		function formatDuration(value, key) {
			if (value === undefined) {
				return undefined;
			}
			const lowerKey = String(key || '').toLowerCase();
			const ms = lowerKey.includes('ms') || lowerKey.includes('millis') ? value : value >= 1000 ? value : value * 1000;
			if (ms < 1000) {
				return Math.round(ms) + ' ms';
			}
			const seconds = ms / 1000;
			if (seconds < 60) {
				return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(seconds) + ' s';
			}
			const minutes = Math.floor(seconds / 60);
			const remainder = Math.round(seconds % 60);
			return minutes + 'm ' + remainder + 's';
		}
		function formatMoney(value) {
			if (value === undefined) {
				return undefined;
			}
			return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
		}
		function estimateTokenCost(input, output, model) {
			const pair = modelPricePair(model);
			if (!pair) {
				return undefined;
			}
			return ((input ?? 0) * pair[0] + (output ?? 0) * pair[1]) / 1000000;
		}
		function formatTokenSpeed(total, durationValue, durationKey) {
			if (total === undefined || durationValue === undefined) {
				return undefined;
			}
			const lowerKey = String(durationKey || '').toLowerCase();
			const ms = lowerKey.includes('ms') || lowerKey.includes('millis') ? durationValue : durationValue >= 1000 ? durationValue : durationValue * 1000;
			if (!Number.isFinite(ms) || ms <= 0) {
				return undefined;
			}
			const tokensPerSecond = total / (ms / 1000);
			return new Intl.NumberFormat(undefined, { maximumFractionDigits: tokensPerSecond < 10 ? 1 : 0 }).format(tokensPerSecond) + ' tok/s';
		}
		function labelFromKey(key) {
			return String(key || '')
				.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
				.replace(/[_-]+/g, ' ')
				.replace(/\b\w/g, character => character.toUpperCase());
		}
		function normalizeUsagePayload(payload) {
			let source = payload;
			if (typeof source === 'string') {
				try {
					source = JSON.parse(source);
				} catch {
					source = { raw: source };
				}
			}
			if (!source || typeof source !== 'object') {
				source = { raw: source };
			}
			const context = source.contextUsage && typeof source.contextUsage === 'object' ? source.contextUsage : {};
			const input = firstNumber(source, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
			const output = firstNumber(source, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
			const total = firstNumber(source, ['totalTokens', 'total_tokens', 'tokens']) ?? ((input ?? 0) + (output ?? 0) || undefined);
			const contextUsed = firstNumber(context, ['used_tokens', 'usedTokens', 'used']);
			const contextLimit = firstNumber(context, ['context_limit', 'contextLimit', 'limit']);
			const summaryTokens = firstNumber(context, ['summary_tokens', 'summaryTokens']);
			const contextPercent = firstNumber(context, ['percent', 'percentage']);
			const computedPercent = contextPercent !== undefined ? contextPercent : contextUsed !== undefined && contextLimit ? contextUsed / contextLimit * 100 : undefined;
			const model = firstString(source, ['model', 'modelName', 'model_name']);
			const timeKey = ['durationMs', 'durationInMillis', 'elapsedMs', 'timeMs', 'totalTimeMs', 'duration', 'elapsed', 'time'].find(key => numberValue(source[key]) !== undefined);
			const spendKey = ['spendage', 'spend', 'cost', 'totalCost', 'total_cost', 'usd', 'amountUsd', 'amount_usd'].find(key => numberValue(source[key]) !== undefined);
			const durationValue = timeKey ? numberValue(source[timeKey]) : undefined;
			const reportedSpend = spendKey ? numberValue(source[spendKey]) : undefined;
			const estimatedSpend = reportedSpend ?? estimateTokenCost(input, output, currentModel());
			const tokenSpeed = formatTokenSpeed(total, durationValue, timeKey);
			const known = new Set(['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'totalTokens', 'total_tokens', 'tokens', 'contextUsage', 'model', 'modelName', 'model_name', timeKey, spendKey].filter(Boolean));
			const metrics = [];
			if (input !== undefined) {
				metrics.push(['Input', formatNumber(input)]);
			}
			if (output !== undefined) {
				metrics.push(['Output', formatNumber(output)]);
			}
			if (total !== undefined) {
				metrics.push(['Total', formatNumber(total)]);
			}
			if (contextUsed !== undefined || contextLimit !== undefined || computedPercent !== undefined) {
				const parts = [];
				if (contextUsed !== undefined && contextLimit !== undefined) {
					parts.push(formatNumber(contextUsed) + ' / ' + formatNumber(contextLimit));
				} else if (contextUsed !== undefined) {
					parts.push(formatNumber(contextUsed));
				}
				if (computedPercent !== undefined) {
					parts.push(formatPercent(computedPercent));
				}
				metrics.push(['Context', parts.join(' · ')]);
			}
			if (summaryTokens !== undefined) {
				metrics.push(['Summary', formatNumber(summaryTokens)]);
			}
			if (model) {
				metrics.push(['Model', model]);
			}
			if (timeKey) {
				metrics.push(['Time', formatDuration(durationValue, timeKey)]);
			}
			if (tokenSpeed) {
				metrics.push(['Speed', tokenSpeed]);
			}
			if (estimatedSpend !== undefined) {
				metrics.push([reportedSpend !== undefined ? 'Cost' : 'Est. Cost', formatMoney(estimatedSpend)]);
			}
			for (const [key, value] of Object.entries(source)) {
				if (known.has(key) || value === undefined || value === null || typeof value === 'object') {
					continue;
				}
				const numeric = numberValue(value);
				metrics.push([labelFromKey(key), numeric !== undefined ? formatNumber(numeric) : String(value)]);
			}
			return {
				percent: Math.max(0, Math.min(100, computedPercent ?? 0)),
				summary: [total !== undefined ? formatNumber(total) + ' tokens' : undefined, estimatedSpend !== undefined ? formatMoney(estimatedSpend) : undefined, tokenSpeed, computedPercent !== undefined ? formatPercent(computedPercent) + ' context' : undefined, model].filter(Boolean).join(' · ') || 'Usage details',
				metrics
			};
		}
		function normalizeBillingSnapshot(payload) {
			const source = payload && typeof payload === 'object' ? payload : {};
			const balance = source.balance && typeof source.balance === 'object' ? source.balance : {};
			const summary = source.summary && typeof source.summary === 'object' ? source.summary : {};
			const recent = source.recent && typeof source.recent === 'object' ? source.recent : {};
			const metrics = [];
			const balanceUsd = firstNumber(balance, ['balance_usd', 'balanceUsd', 'balance']);
			const totalSpending = firstNumber(summary, ['total_spending_usd', 'totalSpendingUsd', 'spending']);
			const tokenSpend = firstNumber(summary, ['token_usage_usd', 'tokenUsageUsd']);
			const inputTokens = firstNumber(summary, ['token_input_tokens', 'tokenInputTokens', 'input_tokens']);
			const outputTokens = firstNumber(summary, ['token_output_tokens', 'tokenOutputTokens', 'output_tokens']);
			const reads = firstNumber(summary, ['reads_count', 'readsCount', 'vector_reads']);
			const writes = firstNumber(summary, ['writes_count', 'writesCount']);
			const recentData = Array.isArray(recent.data) ? recent.data : Array.isArray(recent.usage) ? recent.usage : [];
			if (balanceUsd !== undefined) {
				metrics.push(['Balance', formatMoney(balanceUsd)]);
			}
			if (totalSpending !== undefined) {
				metrics.push(['Period Spend', formatMoney(totalSpending)]);
			}
			if (tokenSpend !== undefined) {
				metrics.push(['Token Spend', formatMoney(tokenSpend)]);
			}
			if (inputTokens !== undefined || outputTokens !== undefined) {
				metrics.push(['Tokens', [inputTokens !== undefined ? formatNumber(inputTokens) + ' in' : undefined, outputTokens !== undefined ? formatNumber(outputTokens) + ' out' : undefined].filter(Boolean).join(' / ')]);
			}
			if (reads !== undefined) {
				metrics.push(['Reads', formatNumber(reads)]);
			}
			if (writes !== undefined) {
				metrics.push(['Writes', formatNumber(writes)]);
			}
			if (recentData.length) {
				metrics.push(['Recent Events', formatNumber(recentData.length)]);
			}
			return {
				percent: 0,
				summary: [balanceUsd !== undefined ? 'Balance ' + formatMoney(balanceUsd) : undefined, totalSpending !== undefined ? 'Period ' + formatMoney(totalSpending) : undefined].filter(Boolean).join(' · ') || 'Billing usage',
				metrics
			};
		}
		function appendUsage(payload) {
			const usage = normalizeUsagePayload(payload);
			latestUsage = usage;
			syncComposerButtons();
			if (activePopover === 'usage') {
				renderPopover('usage');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			}
			return undefined;
		}
		function appendFileChange(change) {
			if (!change || !change.path) {
				return;
			}
			breakAssistantStream();
			fileChanges = fileChanges.filter(item => item.path !== change.path).concat(change);
			renderChangeStack();
			saveActiveHistory();
		}
		function createFileChangeCard(change) {
			const card = document.createElement('div');
			card.className = 'fileCard';
			const header = document.createElement('div');
			header.className = 'fileHeader';
			const dot = document.createElement('span');
			dot.className = 'typeDot';
			dot.appendChild(icon('info'));
			const name = document.createElement('div');
			name.className = 'fileName';
			name.textContent = change.path;
			const added = document.createElement('span');
			added.className = 'fileCount add';
			added.textContent = '+' + (change.added || 0);
			const removed = document.createElement('span');
			removed.className = 'fileCount remove';
			removed.textContent = '-' + (change.removed || 0);
			header.append(dot, name, added, removed);
			card.appendChild(header);
			for (const line of change.previewLines || []) {
				const row = document.createElement('div');
				row.className = 'diffLine ' + (line.type || 'context');
				row.textContent = (line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ') + (line.text || '');
				card.appendChild(row);
			}
			return card;
		}
		function fileChangeTotals() {
			return fileChanges.reduce((totals, change) => ({
				added: totals.added + (Number(change.added) || 0),
				removed: totals.removed + (Number(change.removed) || 0)
			}), { added: 0, removed: 0 });
		}
		function renderChangeStack() {
			if (!changeStack) {
				return;
			}
			changeStack.textContent = '';
			changeStack.classList.toggle('visible', fileChanges.length > 0);
			if (!fileChanges.length) {
				return;
			}
			const totals = fileChangeTotals();
			const wrap = document.createElement('div');
			wrap.id = 'reviewBlock';
			wrap.className = 'reviewWrap';
			const card = document.createElement('div');
			card.className = 'reviewCard';
			const header = document.createElement('div');
			header.className = 'reviewHeader';
			const dot = document.createElement('span');
			dot.className = 'typeDot';
			dot.appendChild(icon('git-compare'));
			const title = document.createElement('span');
			title.className = 'reviewTitle';
			title.textContent = 'Changed ' + fileChanges.length + ' ' + (fileChanges.length === 1 ? 'file' : 'files') + ', +' + totals.added + ' -' + totals.removed;
			const review = document.createElement('button');
			review.className = 'reviewButton';
			review.type = 'button';
			review.textContent = 'Review';
			review.dataset.logAction = 'reviewChanges';
			header.append(dot, title, review);
			card.appendChild(header);
			wrap.appendChild(card);
			changeStack.appendChild(wrap);
			for (const change of fileChanges) {
				changeStack.appendChild(createFileChangeCard(change));
			}
			changeStack.scrollTop = changeStack.scrollHeight;
		}
		function appendRow(role, text) {
			if (role === 'assistant' || role === 'user' || role === 'reasoning') {
				return appendMessage(role, text);
			}
			if (role === 'error') {
				return appendStatus(text, 'error');
			}
			updateStatus(text || '');
			return undefined;
		}
		function appendDelta(role, text) {
			if (role === 'reasoning') {
				const activeReasoning = currentReasoningCard && latestTranscriptNode() === currentReasoningCard ? currentReasoningCard : undefined;
				const target = activeReasoning?.querySelector('.reasoningText') || appendReasoningMessage('');
				queueTextAppend(target, text || '');
				return;
			}
			if (role !== 'assistant') {
				appendRow(role, text);
				return;
			}
			const activeAssistant = currentAssistantCard && latestTranscriptNode() === currentAssistantCard ? currentAssistantCard : undefined;
			const target = activeAssistant?.querySelector('.messageText') || appendMessage('assistant', '');
			const incoming = text || '';
			const current = (target.textContent || '') + (pendingTextAppends.get(target) || '');
			const spacer = current && incoming && /[.:!?)]$/.test(current) && /^[A-Z0-9"'(]/.test(incoming) ? ' ' : '';
			queueTextAppend(target, spacer + incoming);
		}
		function renderQuestion(payload) {
			if (!payload || !payload.id) {
				return;
			}
			breakAssistantStream();
			document.getElementById('question-' + payload.id)?.remove();
			const card = document.createElement('div');
			card.id = 'question-' + payload.id;
			card.className = 'questionCard';
			const header = document.createElement('div');
			header.className = 'questionHeader';
			const title = document.createElement('div');
			title.className = 'questionTitle';
			title.textContent = payload.question || 'Backboard needs input.';
			const nav = document.createElement('div');
			nav.className = 'questionNav';
			nav.append(icon('chevron-left'));
			const count = document.createElement('span');
			count.textContent = '1 of 1';
			nav.append(count, icon('chevron-right'));
			const close = document.createElement('button');
			close.className = 'iconButton';
			close.type = 'button';
			close.title = 'Dismiss';
			close.appendChild(icon('close'));
			close.addEventListener('click', () => {
				card.remove();
				vscode.postMessage({ type: 'dismissQuestion', id: payload.id });
			});
			nav.appendChild(close);
			header.append(title, nav);
			card.appendChild(header);
			const options = Array.isArray(payload.options) ? payload.options : [];
			options.forEach((option, index) => {
				const button = document.createElement('button');
				button.className = 'questionOption';
				button.type = 'button';
				const number = document.createElement('span');
				number.className = 'questionNumber';
				number.textContent = String(index + 1);
				const label = document.createElement('span');
				label.textContent = option;
				button.append(number, label);
				button.addEventListener('click', () => {
					card.remove();
					vscode.postMessage({ type: 'questionResponse', id: payload.id, value: option });
				});
				card.appendChild(button);
				card.appendChild(Object.assign(document.createElement('div'), { className: 'questionDivider' }));
			});
			const inputRow = document.createElement('div');
			inputRow.className = 'questionInputRow';
			const number = document.createElement('span');
			number.className = 'questionNumber';
			number.appendChild(icon('edit'));
			const input = document.createElement('input');
			input.className = 'questionInput';
			input.placeholder = 'Enter text here';
			const skip = document.createElement('button');
			skip.className = 'questionSkip';
			skip.type = 'button';
			skip.textContent = 'Skip';
			const sendQuestion = value => {
				card.remove();
				vscode.postMessage({ type: 'questionResponse', id: payload.id, value });
			};
			input.addEventListener('keydown', event => {
				if (event.key === 'Enter') {
					event.preventDefault();
					sendQuestion(input.value || 'No response.');
				}
			});
			skip.addEventListener('click', () => sendQuestion('No response.'));
			inputRow.append(number, input, skip);
			card.appendChild(inputRow);
			log.appendChild(card);
			scrollConversation();
			input.focus();
		}
		function urlsFrom(value) {
			const urls = [];
			const visit = item => {
				if (!item) return;
				if (typeof item === 'string') {
					if (/^(https?:|data:|blob:)/.test(item)) urls.push(item);
				} else if (Array.isArray(item)) {
					item.forEach(visit);
				} else if (typeof item === 'object') {
					Object.values(item).forEach(visit);
				}
			};
			visit(value);
			return urls;
		}
		function renderMedia(role, payload) {
			breakAssistantStream();
			const row = document.createElement('div');
			row.className = 'mediaBlock';
			row.textContent = role === 'voice' ? 'Voice output' : 'Generated media';
			for (const url of urlsFrom(payload)) {
				if (/\\.(png|jpe?g|gif|webp|svg)(\\?|$)/i.test(url) || url.startsWith('data:image/')) {
					const img = document.createElement('img');
					img.src = url;
					row.appendChild(img);
				} else if (role === 'voice' || /\\.(mp3|wav|ogg|m4a|webm)(\\?|$)/i.test(url) || url.startsWith('data:audio/')) {
					const audio = document.createElement('audio');
					audio.controls = true;
					audio.src = url;
					row.appendChild(audio);
				}
			}
			if (row.childElementCount === 0) {
				row.textContent += '\\n' + JSON.stringify(payload, null, 2).slice(0, 2000);
			}
			log.appendChild(row);
			scrollConversation();
		}
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'clear') {
				clearConversation();
			} else if (message.type === 'runStarted') {
				if (pendingQueuedSendId) {
					promptQueue = promptQueue.filter(item => item.id !== pendingQueuedSendId);
					pendingQueuedSendId = undefined;
					renderQueue();
					saveActiveHistory();
				}
				if (message.chatId && message.chatId !== activeHistoryId) {
					activeHistoryId = message.chatId;
				}
				if (!activeHistoryEntry()) {
					beginHistoryRun(message.prompt || '', message.chatId);
				}
				runInProgress = true;
				stopRequested = false;
				activeToolRows = [];
				activeToolGroup = undefined;
				startRunTimer(Date.now());
				setActiveView('chat');
				appendMessage('user', message.prompt || '');
				syncComposerButtons();
				scrollConversation(true);
			} else if (message.type === 'runFinished') {
				runInProgress = false;
				stopRequested = false;
				stopRunTimer();
				currentAssistantCard = undefined;
				currentReasoningCard = undefined;
				closeActiveToolGroup('finished');
				syncComposerButtons();
				saveActiveHistory('Done');
				renderHistory();
				drainPromptQueue();
				if (promptQueue.length) {
					updateStatus('Prompt queued. Press Run to send it.');
				}
			} else if (message.type === 'sendRejected') {
				runInProgress = false;
				stopRequested = false;
				stopRunTimer();
				if (pendingQueuedSendId) {
					const item = promptQueue.find(item => item.id === pendingQueuedSendId);
					if (item) {
						item.pending = false;
					}
					pendingQueuedSendId = undefined;
				}
				currentAssistantCard = undefined;
				currentReasoningCard = undefined;
				syncComposerButtons();
				renderQueue();
				saveActiveHistory();
				updateStatus(message.text || 'Backboard is still finishing the previous turn. Try Run again.');
			} else if (message.type === 'status') {
				const statusText = message.text || '';
				const doneStatus = statusText.trim().replace(/\.$/, '').toLowerCase() === 'done';
				updateStatus(promptQueue.length && doneStatus ? 'Prompt queued. Press Run to send it.' : statusText);
				if (/cancelled/i.test(statusText)) {
					runInProgress = false;
					stopRequested = false;
					stopRunTimer();
					closeActiveToolGroup('finished');
					syncComposerButtons();
					saveActiveHistory('Cancelled');
					renderHistory();
				} else if (/failed/i.test(statusText)) {
					runInProgress = false;
					stopRequested = false;
					stopRunTimer();
					closeActiveToolGroup('failed');
					syncComposerButtons();
					saveActiveHistory('Failed');
					renderHistory();
				}
			} else if (message.type === 'settings') {
				const nextWorkspace = typeof message.workspace === 'string' ? message.workspace : currentWorkspace;
				const workspaceChanged = nextWorkspace !== currentWorkspace;
				currentWorkspace = nextWorkspace;
				applySettings(message.settings);
				if (workspaceChanged) {
					detachActiveHistoryIfWorkspaceChanged();
				}
				refreshWorkspaceStatus();
				persistPanelState();
			} else if (message.type === 'panelStateSnapshot') {
				applyPanelStateSnapshot(message.state, false);
			} else if (message.type === 'command') {
				if (typeof message.workspace === 'string' && message.workspace && message.workspace !== currentWorkspace) {
					currentWorkspace = message.workspace;
					detachActiveHistoryIfWorkspaceChanged();
					refreshWorkspaceStatus();
					persistPanelState();
				}
				if (message.command === 'newChat') {
					startNewChat();
				} else if (message.command === 'showHistory') {
					setActiveView('history');
				} else if (message.command === 'showChat') {
					setActiveView('chat');
				} else if (message.command === 'openHistoryEntry' && typeof message.chatId === 'string') {
					restoreHistoryEntry(message.chatId);
					setActiveView('chat');
				}
			} else if (message.type === 'models') {
				models = (message.models || []).filter(isVisibleModel);
				renderModels();
				if (activePopover) {
					renderPopover(activePopover);
					if (activeAnchor) {
						positionPopover(activeAnchor);
					}
				}
			} else if (message.type === 'tools') {
				tools = message.tools || [];
				renderToolCount();
				if (activePopover) {
					renderPopover(activePopover);
					if (activeAnchor) {
						positionPopover(activeAnchor);
					}
				}
			} else if (message.type === 'append') {
				appendRow(message.role, message.text);
			} else if (message.type === 'insertText') {
				insertAtCursor(message.text || '');
			} else if (message.type === 'delta') {
				appendDelta(message.role || 'assistant', message.text);
			} else if (message.type === 'reasoningDelta') {
				appendDelta('reasoning', message.payload?.text || message.text || '');
			} else if (message.type === 'question') {
				renderQuestion(message.payload);
			} else if (message.type === 'fileChange') {
				appendFileChange(message.payload);
			} else if (message.type === 'media' || message.type === 'voice') {
				renderMedia(message.type, message.payload);
			} else if (message.type === 'usage') {
				appendUsage(message.payload);
			} else if (message.type === 'usageSnapshot') {
				accountUsage = normalizeBillingSnapshot(message.payload);
				updateStatus('Usage loaded.');
				syncComposerButtons();
				if (activePopover === 'usage') {
					renderPopover('usage');
					if (activeAnchor) {
						positionPopover(activeAnchor);
					}
				}
			} else if (message.type === 'sessionBinding') {
				updateStatus('Connected to Backboard.');
			} else if (message.type === 'toolRequested') {
				const calls = message.payload || [];
				for (const call of calls) {
					appendTool({ status: 'started', key: toolKey(call), name: toolName(call), args: toolArgs(call) });
				}
			} else if (message.type === 'toolOutput') {
				appendToolOutput(message.payload || {});
			} else if (message.type === 'toolFinished') {
				appendTool(message.payload || {});
			}
		});
		applySettings({});
		renderToolCount();
		renderHistory();
		renderChangeStack();
		renderQueue();
			setActiveView(activeView);
			applyPanelStateSnapshot(persistedState, true);
			if (hasPanelSnapshotContent(persistedState)) {
				persistPanelState();
			}
			syncEmptyState();
			syncRootHeight();
		requestAnimationFrame(() => {
			syncRootHeight();
			requestAnimationFrame(syncRootHeight);
		});
		vscode.postMessage({ type: 'ready' });
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) {
				vscode.postMessage({ type: 'syncPanelState' });
			}
		});
		window.addEventListener('pagehide', () => {
			flushPendingTextAppends();
			saveActiveHistory();
			flushPanelState();
		});
	</script>
</body>
</html>`;
}

function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[character] ?? character));
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from './binarySizeStatusBarEntry';
import { MediaPreview, isGitLfsPointer } from './mediaPreview';
import { escapeAttribute } from './util/dom';
import { generateUuid } from './util/uuid';

class PdfPreview extends MediaPreview {
	constructor(
		private readonly extensionRoot: vscode.Uri,
		resource: vscode.Uri,
		panel: vscode.WebviewPanel,
		binarySize: BinarySizeStatusBarEntry,
	) {
		super(extensionRoot, resource, panel, binarySize);
		this.updateBinarySize();
		void this.render();
		this.updateState();
	}

	protected async getWebviewContents(): Promise<string> {
		const webview = this._webviewEditor.webview;
		const asset = (...parts: string[]) => escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionRoot, 'pdf-preview-out', ...parts)).toString());
		const settings = {
			src: webview.asWebviewUri(this._resource.query ? this._resource : this._resource.with({ query: `version=${Date.now()}` })).toString(),
			assetRoot: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionRoot, 'pdf-preview-out')).toString() + '/',
			isGitLfs: await isGitLfsPointer(this._resource),
			loading: vscode.l10n.t('Loading PDF…'),
			error: vscode.l10n.t('Unable to open this PDF. The file may be damaged or unavailable.'),
			gitLfs: vscode.l10n.t('This PDF is stored with Git LFS and is not available for preview.'),
			password: vscode.l10n.t('Enter the password for this PDF.'),
			incorrectPassword: vscode.l10n.t('Incorrect password. Try again.'),
		};
		const nonce = generateUuid();
		const label = (text: string) => escapeAttribute(text);
		const icon = (path: string) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
		const button = (id: string, title: string, path: string, text = '') => `<button id="${id}" type="button" disabled title="${label(title)}" aria-label="${label(title)}">${icon(path)}${text ? `<span class="button-label">${text}</span>` : ''}</button>`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource}; worker-src blob:; connect-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src blob: data: ${webview.cspSource}; font-src blob: ${webview.cspSource};">
	<meta id="settings" data-settings="${escapeAttribute(JSON.stringify(settings))}">
	<title>${vscode.l10n.t('PDF Preview')}</title>
	<link rel="stylesheet" href="${asset('pdfPreview.css')}">
</head>
<body>
	<nav aria-label="${label(vscode.l10n.t('PDF Controls'))}">
		<div class="control-group page-controls" role="group" aria-label="${label(vscode.l10n.t('Page Navigation'))}">
			${button('previous', vscode.l10n.t('Previous Page'), 'M10 4 6 8l4 4')}
			<div class="page-position">
				<input id="page-number" type="number" min="1" value="1" disabled aria-label="${label(vscode.l10n.t('Page Number'))}">
				<span id="page-count">/ —</span>
			</div>
			${button('next', vscode.l10n.t('Next Page'), 'M6 4l4 4-4 4')}
		</div>
		<div class="view-controls">
			<div class="control-group zoom-controls" role="group" aria-label="${label(vscode.l10n.t('Zoom'))}">
				${button('zoom-out', vscode.l10n.t('Zoom Out'), 'M4 8h8')}
				<span id="zoom-level">—</span>
				${button('zoom-in', vscode.l10n.t('Zoom In'), 'M4 8h8M8 4v8')}
			</div>
			<span class="separator" aria-hidden="true"></span>
			${button('fit', vscode.l10n.t('Fit to Width'), 'M2 3v10M14 3v10M5 8h6M6 6 4 8l2 2M10 6l2 2-2 2', vscode.l10n.t('Fit'))}
			${button('rotate', vscode.l10n.t('Rotate Clockwise'), 'M12.5 5A5 5 0 1 0 13 9M10 5h3V2')}
		</div>
	</nav>
	<div class="document-body">
	<div id="status-panel"><span class="loading-spinner" aria-hidden="true"></span><span id="status" role="status">${settings.loading}</span><button id="retry" hidden>${vscode.l10n.t('Try Again')}</button></div>
	<div id="password-prompt" hidden>
		<label id="password-label" for="password"></label>
		<input id="password" type="password" autocomplete="off">
		<button id="unlock">${vscode.l10n.t('Unlock PDF')}</button>
	</div>
	<main id="viewport" tabindex="0" aria-busy="true" aria-label="${label(vscode.l10n.t('PDF Document'))}"><div id="page" class="pdfViewer"></div></main>
	</div>
	<script type="module" nonce="${nonce}" src="${asset('pdfPreview.js')}"></script>
</body>
</html>`;
	}
}

export function registerPdfPreviewSupport(context: vscode.ExtensionContext, binarySize: BinarySizeStatusBarEntry): vscode.Disposable {
	return vscode.window.registerCustomEditorProvider('vscode.pdfPreview', {
		openCustomDocument: async (uri: vscode.Uri) => ({ uri, dispose: () => { } }),
		resolveCustomEditor: async (document: vscode.CustomDocument, panel: vscode.WebviewPanel) => {
			new PdfPreview(context.extensionUri, document.uri, panel, binarySize);
		},
	}, {
		supportsMultipleEditorsPerDocument: true,
		webviewOptions: { retainContextWhenHidden: true },
	});
}

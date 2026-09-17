/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import 'mocha';
import * as vscode from 'vscode';
import { MarkdownContributionProvider, MarkdownContributions } from '../markdownExtensions';
import { MdDocumentRenderer } from '../preview/documentRenderer';
import { StaticMarkdownPreview } from '../preview/preview';
import { MarkdownPreviewConfigurationManager } from '../preview/previewConfig';
import { TopmostLineMonitor } from '../preview/topmostLineMonitor';
import { MdLinkOpener } from '../util/openDocumentLink';
import { ToWebviewMessage } from '../../types/previewMessaging';
import { nulLogger } from './nulLogging';

suite('markdown.preview.streaming', () => {
	const disposables: vscode.Disposable[] = [];

	teardown(() => {
		vscode.Disposable.from(...disposables.splice(0)).dispose();
	});

	async function waitFor(predicate: () => boolean): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (!predicate()) {
			assert.ok(Date.now() < deadline, 'Preview did not update');
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	}

	async function createPreview() {
		const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# Streaming preview' });
		const onMessage = new vscode.EventEmitter<void>();
		const onDispose = new vscode.EventEmitter<void>();
		const onViewState = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
		const onContributions = new vscode.EventEmitter<MarkdownContributionProvider>();
		const monitor = new TopmostLineMonitor();
		disposables.push(onMessage, onDispose, onViewState, onContributions, monitor);
		let html = '';
		let pageLoads = 0;
		let changedLine = 0;
		const messages: ToWebviewMessage.Type[] = [];
		const webview: vscode.Webview = {
			options: {},
			get html() { return html; },
			set html(value: string) { html = value; pageLoads++; },
			onDidReceiveMessage: onMessage.event,
			postMessage: async message => { messages.push(message); return true; },
			asWebviewUri: resource => resource,
			cspSource: 'test',
		};
		const panel: vscode.WebviewPanel = {
			webview,
			viewType: 'markdown-preview-test',
			title: 'Preview',
			options: {},
			viewColumn: vscode.ViewColumn.One,
			active: true,
			visible: true,
			onDidDispose: onDispose.event,
			onDidChangeViewState: onViewState.event,
			reveal: () => { },
			dispose: () => onDispose.fire(),
		};
		const renderer = {
			iconPath: { light: document.uri, dark: document.uri },
			renderDocument: async () => ({ html: '<html>preview</html>', containingImages: new Set<string>() }),
			renderBody: async () => ({ html: '<div>updated preview</div>', containingImages: new Set<string>() }),
			renderFileNotFoundDocument: () => '<html>missing</html>',
		} as unknown as MdDocumentRenderer;
		const preview = StaticMarkdownPreview.revive(document.uri, panel, renderer,
			new MarkdownPreviewConfigurationManager(), monitor, nulLogger, {
				extensionUri: document.uri,
				contributions: MarkdownContributions.Empty,
				onContributionsChanged: onContributions.event,
				dispose: () => { },
			}, {} as MdLinkOpener, undefined, () => ({ added: [changedLine] }));
		disposables.push(preview);
		await waitFor(() => pageLoads === 1);
		return { preview, document, messages, get pageLoads() { return pageLoads; }, setChangedLine: (line: number) => { changedLine = line; } };
	}

	test('counterpart changes update diff decorations without reloading an unchanged document', async () => {
		const fixture = await createPreview();
		fixture.setChangedLine(4);
		fixture.preview.refresh(false);
		await waitFor(() => fixture.messages.some(message => message.type === 'updateContent'));
		const update = fixture.messages.find(message => message.type === 'updateContent');
		assert.deepStrictEqual({ pageLoads: fixture.pageLoads, lines: update?.lineChanges?.added }, { pageLoads: 1, lines: [4] });
	});

	test('document edits update the existing preview page', async () => {
		const fixture = await createPreview();
		const edit = new vscode.WorkspaceEdit();
		edit.insert(fixture.document.uri, new vscode.Position(0, 0), 'New content\n\n');
		await vscode.workspace.applyEdit(edit);
		await waitFor(() => fixture.messages.some(message => message.type === 'updateContent'));
		assert.strictEqual(fixture.pageLoads, 1);
	});

	test('explicit refresh still reloads when a content update is already queued', async () => {
		const fixture = await createPreview();
		fixture.preview.refresh(false);
		fixture.preview.refresh();
		await waitFor(() => fixture.pageLoads === 2);
		assert.strictEqual(fixture.messages.filter(message => message.type === 'updateContent').length, 0);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Real desktop composer regression. Build with `npm run transpile-client`, then run:
// npm run test-simple-suggestions -- [path-to-electron]
// Uses a temporary profile, disabled agent hosts, and deterministic completions.
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const failureScreenshot = path.join(tmpdir(), 'backboard-suggestions-failure.png');

async function main() {
	const product = JSON.parse(await readFile(path.join(root, 'product.json'), 'utf8'));
	const executablePath = process.argv[2] ?? (process.platform === 'darwin'
		? path.join(root, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort)
		: path.join(root, '.build/electron', process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName));
	const temporary = await mkdtemp(path.join(tmpdir(), 'backboard-suggestions-'));
	const profile = path.join(temporary, 'profile');
	await mkdir(path.join(profile, 'User'), { recursive: true });
	await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
		'chat.agentHost.enabled': false,
		'workbench.startupEditor': 'none',
		'workbench.tips.enabled': false,
		'chat.tips.enabled': false,
		'security.workspace.trust.enabled': false,
		'telemetry.telemetryLevel': 'off',
		'editor.accessibilitySupport': 'off',
	}));
	const env = { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1', NODE_ENV: 'development' };
	delete env.ELECTRON_RUN_AS_NODE;
	let app;
	let appProcess;
	let page;
	const rendererErrors = [];
	try {
		app = await _electron.launch({
			executablePath, cwd: root, env, timeout: 30_000, args: [
				root, '--agents', '--user-data-dir', profile, '--agents-user-data-dir', profile,
				'--extensions-dir', path.join(temporary, 'extensions'), '--agents-extensions-dir', path.join(temporary, 'extensions'),
				'--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-extensions', '--skip-welcome', '--skip-sessions-welcome',
			]
		});
		appProcess = app.process();
		page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(window => window.isVisible());
			window.show();
			window.focus();
		});
		page.setDefaultTimeout(30_000);
		console.log('Opened test window');
		page.on('pageerror', error => console.error('Renderer error:', error.message));
		page.on('console', message => { if (message.type() === 'error') { rendererErrors.push(message.text()); } });
		await page.bringToFront();
		await page.waitForSelector('.new-chat-composer-stack .interactive-input-editor .monaco-editor', { timeout: 180_000 });
		const skip = page.getByRole('button', { name: 'Skip Onboarding', exact: true });
		await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => { });
		if (await skip.isVisible()) { await skip.click({ noWaitAfter: true }); }
		await page.bringToFront();
		console.log('Composer ready');

		// Register a test-only command in this renderer to obtain the real workbench
		// services. No test hooks or alternate rendering paths are added to production.
		await page.evaluate(async () => {
			const base = location.href.slice(0, location.href.indexOf('/vs/')) + '/';
			const load = relative => import(base + 'vs/' + relative + '.js');
			const { Action2, registerAction2 } = await load('platform/actions/common/actions');
			const { ICommandService, CommandsRegistry } = await load('platform/commands/common/commands');
			const { ILanguageFeaturesService } = await load('editor/common/services/languageFeatures');
			const { CompletionItemKind } = await load('editor/common/languages');
			const { IChatWidgetService } = await load('workbench/contrib/chat/browser/chat');
			const { ChatDynamicVariableModel } = await load('workbench/contrib/chat/browser/attachments/chatDynamicVariables');
			const { URI } = await load('base/common/uri');
			const { IWorkbenchLayoutService, Parts } = await load('workbench/services/layout/browser/layoutService');
			const { ISessionsPartService } = await load('sessions/services/sessions/browser/sessionsPartService');
			const { applyZoom } = await load('platform/window/electron-browser/window');
			const { constObservable } = await load('base/common/observable');
			const { IChatService } = await load('workbench/contrib/chat/common/chatService/chatService');
			const { ChatAgentLocation } = await load('workbench/contrib/chat/common/constants');
			let fixtureReference;
			let fixtureSession;
			let attachCommand;
			registerAction2(class extends Action2 {
				constructor() { super({ id: 'test.simpleSuggestions.setup', title: 'Test Simple Suggestions Setup', f1: true }); }
				run(accessor) {
					const widgets = accessor.get(IChatWidgetService);
					globalThis.suggestionTest?.provider.dispose();
					attachCommand?.dispose();
					const widget = widgets.getAllWidgets().find(w => w.input.inputEditor.getDomNode()?.closest('.new-chat-composer-stack, .chat-view-chat'));
					if (!widget) { throw new Error('Simple composer is missing'); }
					const editor = widget.input.inputEditor;
					const model = editor.getModel();
					const commands = accessor.get(ICommandService);
					const part = accessor.get(ISessionsPartService);
					const layout = accessor.get(IWorkbenchLayoutService);
					const chatService = accessor.get(IChatService);
					const references = widget.getContrib(ChatDynamicVariableModel.ID);
					let submits = 0;
					// Any accidental submission is a test failure and never reaches an agent.
					widget.acceptInput = async () => { submits++; };
					attachCommand = CommandsRegistry.registerCommand('test.simpleSuggestions.attach', (_accessor, reference) => references.addReference(reference));
					const provider = accessor.get(ILanguageFeaturesService).completionProvider.register({ scheme: model.uri.scheme, pattern: model.uri.path, exclusive: true, hasAccessToAllModels: true }, {
						_debugDisplayName: 'simple-composer-regression',
						triggerCharacters: ['@', '/'],
						provideCompletionItems(model, position) {
							const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
							const match = /[@/][\w.-]*$/.exec(before);
							if (!match) { return { suggestions: [] }; }
							const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: match.index + 1, endColumn: position.column };
							return {
								suggestions: ['alpha.ts', 'beta.ts', 'gamma.ts'].map((name, index) => {
									const insertText = `${match[0][0]}file:${name} `;
									const uri = URI.file(`/fixture/${name}`);
									return {
										label: name, kind: CompletionItemKind.File, sortText: String(index), filterText: `${match[0][0]}${name}`, insertText, range,
										command: { id: 'test.simpleSuggestions.attach', title: '', arguments: [{ id: uri.toString(), isFile: true, data: uri, range: { ...range, endColumn: range.startColumn + insertText.length - 1 } }] }
									};
								})
							};
						},
					});
					globalThis.suggestionTest = {
						editor, widget, commands, provider,
						reset(value = '') { editor.setValue(value); editor.setPosition({ lineNumber: editor.getModel().getLineCount(), column: editor.getModel().getLineMaxColumn(editor.getModel().getLineCount()) }); editor.focus(); },
						state: () => ({ value: editor.getValue(), references: references.variables.map(v => v.data.path), submits }),
						zoom(factor) { applyZoom(Math.log(factor) / Math.log(1.2), window); },
						sidebar(width) {
							layout.setPartHidden(width === 0, Parts.SIDEBAR_PART);
							if (width) { layout.setSize(Parts.SIDEBAR_PART, { ...layout.getSize(Parts.SIDEBAR_PART), width }); }
						},
						showConversation() {
							if (!fixtureReference) {
								fixtureReference = chatService.loadSessionFromData({
									initialLocation: ChatAgentLocation.Chat, responderUsername: 'Test', requests: [
										{ requestId: 'fixture-request', message: 'Fixture question', variableData: { variables: [] }, response: [{ value: 'Fixture answer' }] }
									]
								}, 'simple-suggestions-test');
								const chat = { resource: fixtureReference.object.sessionResource, createdAt: new Date(), title: constObservable('Suggestion fixture'), updatedAt: constObservable(new Date()), status: constObservable(3), changes: constObservable([]), checkpoints: constObservable(undefined), modelId: constObservable(undefined), mode: constObservable(undefined), isArchived: constObservable(false), isRead: constObservable(true), description: constObservable(undefined), lastTurnEnd: constObservable(undefined) };
								fixtureSession = { ...chat, sessionId: 'suggestion-fixture', providerId: 'local', sessionType: 'local', icon: { id: 'comment' }, workspace: constObservable(undefined), changesets: constObservable([]), loading: constObservable(false), chats: constObservable([chat]), mainChat: constObservable(chat), activeChat: constObservable(chat), isCreated: constObservable(true), sticky: constObservable(false), capabilities: { supportsMultipleChats: false } };
							}
							part.updateVisibleSessions([fixtureSession], fixtureSession);
						},
						showDraft() { part.updateVisibleSessions([undefined], undefined); },
						disposeView() { provider.dispose(); attachCommand.dispose(); part.getSessionView(undefined).dispose(); fixtureReference?.dispose(); },
					};
				}
			});
		});
		console.log('Registered setup action');
		await page.locator('.new-chat-composer-stack .interactive-input-editor').click({ noWaitAfter: true });
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
		await page.locator('.quick-input-widget input').fill('>Test Simple Suggestions Setup');
		await expect(page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Test Simple Suggestions Setup' }).first()).toBeVisible();
		await page.keyboard.press('Enter');
		await page.waitForFunction(() => !!globalThis.suggestionTest);
		console.log('Test services ready');
		await expect(page.locator('.quick-input-widget')).toBeHidden();
		await page.bringToFront();

		const popup = page.locator('.suggest-widget.visible');
		async function open(prefix = '@', value = '') {
			await page.keyboard.press('Escape');
			await page.evaluate(value => globalThis.suggestionTest.reset(value), value);
			await page.keyboard.type(prefix);
			await expect(popup).toBeVisible();
			await expect(popup.locator('.monaco-list-row')).toHaveCount(3);
		}
		async function assertPosition() {
			await expect.poll(async () => page.evaluate(() => {
				const editor = globalThis.suggestionTest.editor;
				const node = document.querySelector('.suggest-widget.visible');
				const rect = node.getBoundingClientRect();
				const bounds = editor.getDomNode().getBoundingClientRect();
				const caret = editor.getScrolledVisiblePosition(editor.getPosition());
				const scale = editor.getDomNode().getBoundingClientRect().width / editor.getDomNode().offsetWidth;
				const x = bounds.left + caret.left * scale;
				const y = bounds.top + caret.top * scale;
				const nearCaret = Math.min(Math.abs(rect.bottom - y), Math.abs(rect.top - (y + caret.height * scale))) < 12;
				const inViewport = rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
				const aligned = Math.abs(rect.left - x) < 16 || (rect.left <= x && rect.right >= x);
				return { nearCaret, inViewport, aligned, outsideComposer: !node.closest('.new-chat-composer-stack') };
			})).toEqual({ nearCaret: true, inViewport: true, aligned: true, outsideComposer: true });
		}
		async function assertSelection(name) {
			await expect(popup).toBeHidden();
			await expect.poll(() => page.evaluate(() => globalThis.suggestionTest.state())).toEqual({ value: `@file:${name} `, references: [`/fixture/${name}`], submits: 0 });
		}

		await open();
		await assertPosition();
		const composerBounds = await page.locator('.new-chat-composer-stack').boundingBox();
		await page.keyboard.type('be');
		assert.deepEqual(await page.locator('.new-chat-composer-stack').boundingBox(), composerBounds);
		await assertPosition();
		await expect(popup.locator('.monaco-list-row')).toHaveCount(1);
		await page.keyboard.press('Enter');
		await assertSelection('beta.ts');
		await open();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Tab');
		await assertSelection('beta.ts');
		await open();
		await popup.getByText('gamma.ts', { exact: true }).click({ noWaitAfter: true });
		await assertSelection('gamma.ts');
		await open();
		await page.keyboard.press('Escape');
		await page.keyboard.type(' still typing');
		await expect(popup).toBeHidden();
		assert.equal((await page.evaluate(() => globalThis.suggestionTest.state())).value, '@ still typing');
		console.log('PASS: typing, filtering, Enter, Tab, arrows, mouse, Escape, and reference insertion');

		for (const [width, height, zoom, sidebar] of [[1440, 900, 1, 260], [1000, 720, 1, 0], [1200, 800, 1.25, 360], [900, 650, 0.8, 0]]) {
			await page.keyboard.press('Escape');
			await app.evaluate(({ BrowserWindow }, { width, height }) => {
				const window = BrowserWindow.getAllWindows().find(window => window.isVisible());
				window.setSize(width, height);
			}, { width, height });
			await page.evaluate(async ({ zoom, sidebar }) => {
				globalThis.suggestionTest.zoom(zoom);
				globalThis.suggestionTest.sidebar(sidebar);
			}, { zoom, sidebar });
			// Check the effective CSS viewport scale; Electron's main-process
			// getter does not reflect the renderer's per-frame zoom on all builds.
			await expect.poll(async () => Math.abs(await page.evaluate(() => outerWidth / innerWidth) - zoom)).toBeLessThan(0.03);
			await expect(page.locator('.monaco-workbench.parts-animating')).toHaveCount(0);
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			for (const background of [false, true]) {
				await page.evaluate(background => {
					const canvas = document.querySelector('.new-chat-widget-content');
					canvas.classList.toggle('has-custom-background', background);
					const root = document.querySelector('.monaco-workbench');
					root.classList.toggle('sessions-chat-custom-background', background);
					root.style.setProperty('--new-chat-background-image', 'linear-gradient(#42536b, #20242c)');
				}, background);
				await open('@', 'First line\nSecond line\n');
				await assertPosition();
				await open('/');
				await assertPosition();
			}
		}
		console.log('PASS: placement with resize, sidebar, zoom, multiline input, backgrounds, and slash suggestions');
		await page.keyboard.press('Escape');
		await open();
		// Navigate through the real session host with a local, already completed
		// conversation. No network request or agent submission is involved.
		await page.evaluate(() => globalThis.suggestionTest.showConversation());
		await expect(popup).toBeHidden();
		await expect(page.locator('.monaco-workbench > .chat-editor-overflow')).toHaveCount(0);
		await expect(page.getByText('Fixture answer', { exact: true })).toBeVisible();
		await page.evaluate(() => globalThis.suggestionTest.commands.executeCommand('test.simpleSuggestions.setup'));
		await open();
		await page.keyboard.press('Enter');
		await assertSelection('alpha.ts');
		await open('/');
		await page.keyboard.press('Escape');
		await page.evaluate(() => globalThis.suggestionTest.showDraft());
		await expect(page.locator('.new-chat-composer-stack .interactive-input-editor')).toBeVisible();
		await expect(page.locator('.monaco-workbench > .chat-editor-overflow')).toHaveCount(1);
		await page.evaluate(() => globalThis.suggestionTest.commands.executeCommand('test.simpleSuggestions.setup'));
		await open();
		await assertPosition();
		console.log('PASS: existing conversation, slash suggestions, and navigation back to a fresh draft');
		await page.evaluate(() => globalThis.suggestionTest.disposeView());
		await expect(popup).toBeHidden();
		await expect(page.locator('.chat-editor-overflow')).toHaveCount(0);
		console.log('PASS: disposing the draft removes its popup and container');
	} catch (error) {
		if (page && !page.isClosed()) {
			console.error('Window:', page.url());
			console.error(rendererErrors.slice(-5).join('\n'));
			console.error('Screenshot:', failureScreenshot);
			console.error(await page.evaluate(() => {
				const editor = globalThis.suggestionTest?.editor;
				return { viewport: [innerWidth, innerHeight], caret: editor?.getScrolledVisiblePosition(editor.getPosition()), editor: editor?.getDomNode().getBoundingClientRect().toJSON(), popups: [...document.querySelectorAll('.suggest-widget')].map(e => ({ style: e.getAttribute('style'), rect: e.getBoundingClientRect().toJSON() })) };
			}));
			await page.screenshot({ path: failureScreenshot, timeout: 5_000 }).catch(() => { });
		}
		throw error;
	} finally {
		if (app) {
			const killTimer = setTimeout(() => appProcess.kill('SIGKILL'), 8_000);
			try { await app.close(); } catch { /* The shutdown timeout terminated the test app. */ } finally { clearTimeout(killTimer); }
		}
		await rm(temporary, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });

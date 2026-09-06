/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Headless geometry/hover audit of representative transcript DOM with production CSS.
// This complements component unit tests; it does not launch or alter the desktop app.
// Run from the backboard root: node scripts/chat-ui-layout-audit.mjs [output-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import katex from 'katex';

const output = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'backboard-chat-layout-audit'));
await fs.mkdir(output, { recursive: true });
const base = 'src/vs/workbench/contrib/chat/browser/widget/';
const styles = [
	'node_modules/@vscode/codicons/dist/codicon.css',
	'src/vs/base/browser/ui/button/button.css',
	...['chatCodeBlockPill', 'chatThinkingContent', 'chatSubagentContent', 'chatCoreToolProgressPart', 'chatExternalEditCard', 'chatConfirmationWidget'].map(name => `${base}chatContentParts/media/${name}.css`),
	`${base}media/chat.css`,
];
let css = (await Promise.all(styles.map(file => fs.readFile(file, 'utf8')))).join('\n');
let mathCss = await fs.readFile('node_modules/katex/dist/katex.min.css', 'utf8');
for (const match of [...mathCss.matchAll(/url\((fonts\/[^)]+)\)/g)]) {
	const bytes = await fs.readFile(path.join('node_modules/katex/dist', match[1]));
	mathCss = mathCss.replaceAll(match[0], `url(data:application/octet-stream;base64,${bytes.toString('base64')})`);
}
css += mathCss;
const font = await fs.readFile('node_modules/@vscode/codicons/dist/codicon.ttf');
css = css.replace(/url\(["']?(?:\.\/)?codicon.ttf(?:\?[^"\')]+)?["']?\)/g, `url(data:font/ttf;base64,${font.toString('base64')})`);
for (const name of ['blue-pinwheel', 'teal-bowtie']) {
	const png = await fs.readFile(`${base}media/agent-avatars/${name}.png`);
	css = css.replaceAll(`url('./agent-avatars/${name}.png')`, `url(data:image/png;base64,${png.toString('base64')})`);
}
const glyph = (kind, extra = '') => `<span aria-hidden="true" class="codicon codicon-${kind} ${extra}"></span>`;
const core = (name, kind, text) => `<div class="chat-thinking-tool-wrapper chat-thinking-core-tool-row"><div class="chat-tool-invocation-part"><div class="chat-core-tool-card chat-core-tool-card-${kind}"><button data-row data-disclosure class="chat-core-tool-card-header" aria-expanded="false">${glyph(kind === 'todo' ? 'checklist' : 'search', 'chat-core-tool-card-icon')}<div class="chat-core-tool-card-heading"><div class="chat-core-tool-card-title-line"><span data-label class="chat-core-tool-card-title">${name}</span><span class="chat-core-tool-card-summary">${text}</span></div></div>${glyph('chevron-right', 'chat-core-tool-card-disclosure')}</button><div class="chat-core-tool-card-details" hidden><pre>First match\nSecond match in a long/path/inside/the/workspace/example.ts</pre></div></div></div></div>`;
const thought = `<button data-row data-disclosure class="chat-thinking-cursor-reasoning-label" aria-expanded="false">${glyph('lightbulb', 'chat-thinking-cursor-reasoning-icon')}<span data-label>Thoughts</span>${glyph('chevron-right', 'chat-thinking-cursor-reasoning-chevron')}</button>`;
const io = (name, code = false) => `<div class="chat-thinking-tool-wrapper chat-thinking-io-tool-row"><div class="chat-tool-invocation-part"><div class="chat-tool-io ${code ? '' : 'chat-tool-io-activity'}"><div class="chat-confirmation-widget collapsed"><button data-disclosure ${code ? '' : 'data-row'} aria-expanded="false" class="chat-confirmation-widget-title monaco-button monaco-text-button">${glyph(name === 'RunTests' ? 'error' : 'tools', 'chat-io-activity-icon')}<span class="monaco-button-mdlabel"><span data-label class="chat-tool-io-input-header">${name}</span></span>${glyph('chevron-right', 'chat-collapsible-hover-chevron')}</button><div class="chat-confirmation-widget-message" hidden><div class="chat-tool-io-details"><h3>Input</h3><div class="chat-tool-io-input"><pre>{"workspaceFolder":"/Users/example/project","id":"build"}</pre></div><h3>Output</h3><div class="chat-tool-io-output"><pre style="background:var(--vscode-editor-background)">${name === 'RunTests' ? 'Error: No tests found in the files' : 'Build complete.\nAll checks passed.'}</pre></div></div></div></div></div></div></div>`;
const pill = name => `<div class="chat-subagent-part chat-thinking-fixed-mode"><div class="chat-used-context-label"><a class="monaco-button monaco-text-button" tabindex="0"><span class="monaco-button-mdlabel">${glyph('sparkle', 'chat-subagent-avatar')}<span class="chat-subagent-task">${name}</span></span></a></div></div>`;
const edit = name => `<div data-card class="chat-codeblock-pill-container chat-external-edit-card chat-external-edit-preview"><a class="chat-codeblock-pill-widget"><span class="icon">${glyph('file')}</span><span class="icon-label">${name}</span><span class="label-added">+1</span><span class="label-removed">-0</span></a><button aria-label="Toggle diff" class="chat-external-edit-expand codicon codicon-chevron-down"></button><div class="chat-external-edit-diff-body"><div class="chat-external-edit-diff-row added"><span class="chat-external-edit-diff-gutter">1</span><span class="chat-external-edit-diff-marker">+</span><span class="chat-external-edit-diff-text">export const result = true;</span></div></div></div>`;
const terminal = `<div class="chat-thinking-tool-wrapper chat-thinking-cursor-terminal-row"><div class="chat-terminal-thinking-collapsible chat-used-context-collapsed"><div class="chat-used-context-label"><button data-disclosure class="monaco-button monaco-text-button" aria-expanded="false"><span class="monaco-button-mdlabel chat-terminal-command-label"><span class="chat-terminal-status-text">Running</span><code data-label class="chat-terminal-command-compact">npm run test -- --reporter=verbose --project=very-long-workspace-name</code></span>${glyph('chevron-right', 'chat-collapsible-hover-chevron')}</button></div><div class="chat-terminal-collapsed-output-preview">12 tests passed</div></div></div>`;
const fixture = `<div class="chat-t3-turn-work"><button class="chat-t3-turn-fold">Worked for 10m 8s</button></div><div class="chat-t3-turn-work-body"><div class="chat-thinking-box"><div class="chat-used-context-list chat-thinking-collapsible">${core('Search', 'grep', 'a very long search query that should truncate without pushing icons off the rail')}${thought}${core('Tasks', 'todo', '2 / 4 tasks done')}<div class="chat-thinking-work-group"><div role="button" tabindex="0" data-row data-disclosure class="chat-thinking-group-header" aria-expanded="true">${glyph('tools', 'chat-thinking-icon')}<span data-label class="chat-thinking-group-label">Ran 3 tools</span>${glyph('chevron-right', 'chat-thinking-group-chevron-cursor')}</div><div class="chat-thinking-group-body">${io('RunTask')}${io('GetTaskOutput')}${io('RunTests')}</div></div><div data-row class="chat-thinking-tool-wrapper chat-browser-open-row">${glyph('open-preview', 'chat-thinking-icon')}<span data-label class="chat-browser-open-label">Opened browser page</span></div></div></div><div class="chat-subagent-strip"><div class="chat-subagent-items">${['SmokeSync', 'BatchA', 'A worker with a much longer descriptive name', 'CancelMe'].map(pill).join('')}</div></div>${terminal}${edit('batch-a.ts')}<span hidden></span>${edit('batch-b.ts')}${io('return await page.title();', true)}<div class="rendered-markdown"><h3>Smoke test complete</h3><p>Tools and rendered output stay readable at narrow widths.</p><table><thead><tr><th>Tool</th><th>Result</th></tr></thead><tbody><tr><td><code>runTests</code></td><td>No runner configured for this workspace.</td></tr><tr><td><code>ask_user</code></td><td>Skipped: awaiting an answer.</td></tr></tbody></table>${katex.renderToString(String.raw`\int_0^1 \frac{x^2 + \sqrt{x}}{1+x^4}\,dx`, { displayMode: true })}</div></div>`;
const browser = await chromium.launch({ headless: true });
const results = [];
try {
	for (const theme of ['light', 'dark']) {
		for (const width of [320, 480, 760]) {
			const page = await browser.newPage({ viewport: { width: width + 32, height: 1200 }, deviceScaleFactor: 1 });
			const foreground = theme === 'light' ? '#39382f' : '#d4d4d4';
			const background = theme === 'light' ? '#f4f1eb' : '#18191a';
			await page.setContent(`<style>${css}</style><style>body {margin:0;padding:16px;background:${background};color:${foreground};font:13px/20px Arial;} .audit-host {width:${width}px;--vscode-font-family:Arial;--monaco-monospace-font:monospace;--vscode-foreground:${foreground};--vscode-descriptionForeground:${theme === 'light' ? '#666' : '#aaa'};--vscode-editor-background:${background};--vscode-chat-requestBorder:#8884;--vscode-focusBorder:#57a9ed;--vscode-terminal-foreground:${foreground};} .audit-host .part.auxiliarybar{position:static;width:100%;height:auto;} .audit-host .interactive-session {height:auto;} .audit-host .value {margin:0;padding:0;width:100%;}</style><div class="monaco-workbench ${theme === 'light' ? 'vs' : 'vs-dark'} audit-host"><div class="part auxiliarybar"><div class="chat-viewpane backboard-clean-chat"><div class="interactive-session"><div class="interactive-list backboard-cursor-transcript"><div class="interactive-item-container interactive-response"><div class="value">${fixture}</div></div></div></div></div></div></div>`);
			await page.evaluate(() => {
				const composer = document.createElement('div');
				composer.className = 'interactive-input-part';
				composer.innerHTML = '<div class="chat-editing-session"><div class="chat-editing-session-container"><div class="chat-editing-session-overview">4 files changed +47 −35</div></div></div><div class="chat-input-container">Ask a follow-up…</div>';
				document.querySelector('.interactive-session').append(composer);
			});
			await page.evaluate(() => document.fonts.ready);
			const geometry = await page.evaluate(() => {
				const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
				return {
					terminalStatus: rect(document.querySelector('.chat-terminal-status-text')),
					terminalCommand: rect(document.querySelector('.chat-terminal-command-compact')),
					rows: [...document.querySelectorAll('[data-row]')].map(e => ({ ...rect(e), text: e.textContent.trim(), icon: rect(e.querySelector('.codicon')) })),
					pills: [...document.querySelectorAll('.chat-subagent-part')].map(e => ({ box: rect(e), icon: rect(e.querySelector('.chat-subagent-avatar')), text: rect(e.querySelector('.chat-subagent-task')) })),
					cards: [...document.querySelectorAll('[data-card]')].map(rect),
					host: rect(document.querySelector('.value')),
					table: rect(document.querySelector('table')),
					composer: rect(document.querySelector('.chat-input-container')),
					changedFiles: rect(document.querySelector('.chat-editing-session-container')),
					changedFilesOverflow: document.querySelector('.chat-editing-session-container').scrollWidth - document.querySelector('.chat-editing-session-container').clientWidth,
					composerGap: document.querySelector('.chat-input-container').getBoundingClientRect().top - document.querySelector('.chat-editing-session-container').getBoundingClientRect().bottom,
				};
			});
			const failures = [];
			if (geometry.terminalStatus.x < geometry.terminalCommand.x + geometry.terminalCommand.width - 1) { failures.push('Terminal status must trail the command without overlap'); }
			if (Math.abs(geometry.changedFiles.x - geometry.composer.x) > 1 || Math.abs(geometry.changedFiles.width - geometry.composer.width) > 1 || geometry.changedFilesOverflow > 1) { failures.push('Changed-files strip must match composer edges without overflow'); }
			if (Math.abs(geometry.composerGap + 20) > 1) { failures.push('Changed-files widget must tuck 20px behind the composer'); }
			const check = (ok, message) => { if (!ok) { failures.push(message); } };
			for (const row of geometry.rows) {
				check(row.height === 24, `${row.text}: row height ${row.height}`);
				check(Math.abs(row.icon.x - geometry.rows[0].icon.x) < 1, `${row.text}: icon rail ${row.icon.x}`);
				check(Math.abs(row.icon.y + row.icon.height / 2 - row.y - row.height / 2) < 1, `${row.text}: icon vertical center`);
			}
			for (let index = 1; index < geometry.rows.length; index++) {
				const previous = geometry.rows[index - 1];
				check(Math.abs(geometry.rows[index].y - previous.y - previous.height) < 1, `Uneven activity gap before ${geometry.rows[index].text}`);
			}
			for (const pill of geometry.pills) {
				check(Math.abs(pill.icon.y + pill.icon.height / 2 - pill.box.y - pill.box.height / 2) < 1, 'Agent pill icon center');
				check(pill.box.x + pill.box.width <= geometry.host.x + geometry.host.width + 1, 'Agent pill overflow');
			}
			check(Math.abs(geometry.cards[1].y - geometry.cards[0].y - geometry.cards[0].height - 10) < 1, 'Adjacent diff gap');
			check(geometry.table.width > 0 && geometry.table.width <= geometry.host.width + 1, 'Table exceeds transcript width');
			for (const header of await page.locator('[data-disclosure]').all()) {
				const before = await header.locator('[data-label]').evaluate(e => e.getBoundingClientRect().x);
				await header.hover();
				const after = await header.locator('[data-label]').evaluate(e => e.getBoundingClientRect().x);
				check(before === after, `Hover shifted label: ${await header.textContent()}`);
			}
			for (const card of await page.locator('[data-card]').all()) {
				const centers = await card.evaluate(e => { const icon = e.querySelector('.icon').getBoundingClientRect(); const arrow = e.querySelector('.chat-external-edit-expand').getBoundingClientRect(); return { x: arrow.x + arrow.width / 2 - icon.x - icon.width / 2, y: arrow.y + arrow.height / 2 - icon.y - icon.height / 2 }; });
				check(Math.abs(centers.x) <= 1 && Math.abs(centers.y) <= 1, `Diff disclosure center: ${JSON.stringify(centers)}`);
			}
			await page.mouse.move(0, 0);
			await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
			await page.evaluate(() => {
				for (const section of document.querySelectorAll('.chat-core-tool-card-details, .chat-confirmation-widget-message')) { section.hidden = false; }
				for (const section of document.querySelectorAll('.chat-confirmation-widget')) { section.classList.remove('collapsed'); }
				for (const header of document.querySelectorAll('[data-disclosure]')) { header.setAttribute('aria-expanded', 'true'); }
			});
			const outerSurfaces = await page.evaluate(() => [...document.querySelectorAll('.chat-tool-io-activity .chat-confirmation-widget-message, .chat-tool-io-activity .chat-tool-io-output pre')].map(e => getComputedStyle(e).backgroundColor));
			check(outerSurfaces.every(color => color === 'rgba(0, 0, 0, 0)'), 'Tool output paints outside the details surface');
			const outputInsets = await page.evaluate(() => [...document.querySelectorAll('.chat-tool-io-activity .chat-tool-io-details')].map(e => {const row = e.closest('.chat-tool-io').getBoundingClientRect(); const box = e.getBoundingClientRect(); return Math.abs(box.x - row.x); }));
			check(outputInsets.every(inset => inset < 1), `Nested output insets: ${outputInsets.join(', ')}`);
			const clipping = await page.evaluate(() => [...document.querySelectorAll('.chat-core-tool-card-details pre, .chat-tool-io-details pre')].filter(e => e.scrollWidth > e.clientWidth && !['auto', 'scroll'].includes(getComputedStyle(e).overflowX)).map(e => e.parentElement.className));
			check(clipping.length === 0, `Unscrollable output: ${clipping.join(', ')}`);
			const overflow = await page.evaluate(() => [...document.querySelectorAll('.chat-tool-io, .chat-core-tool-card, .katex-display, table')].filter(element => { const r = element.getBoundingClientRect(); const host = document.querySelector('.value').getBoundingClientRect(); return r.right > host.right + 1 || r.left < host.left - 1; }).map(e => e.className || e.tagName));
			check(overflow.length === 0, `Expanded content exceeds transcript: ${overflow.join(', ')}`);
			await page.screenshot({ path: path.join(output, `${theme}-${width}-expanded.png`), fullPage: true });
			results.push({ theme, width, failures, geometry });
			await page.close();
		}
	}
} finally {
	await browser.close();
}
await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ theme, width, failures }) => ({ theme, width, failures })), null, 2));
console.log(`Screenshots and measurements: ${output}`);
assert.ok(results.every(result => result.failures.length === 0), 'Transcript layout audit failed');

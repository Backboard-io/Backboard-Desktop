/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import vscodeUri from 'vscode-uri';

const { URI, Utils } = vscodeUri;

const root = path.resolve(import.meta.dirname, '..');
const noopEvent = () => ({ dispose() { } });
let provider;
let htmlReady;
let origin;
let browser;
let server;
const panel = {
	active: true,
	onDidChangeViewState: noopEvent,
	onDidDispose: noopEvent,
	webview: {
		get cspSource() { return origin; },
		asWebviewUri(uri) {
			return URI.parse(origin + (uri.path.startsWith(root) ? '/assets' + (uri.path === path.join(root, 'pdf-preview-out') ? '' : '/' + path.relative(path.join(root, 'pdf-preview-out'), uri.path).split(path.sep).map(encodeURIComponent).join('/')) : '/document.pdf')).with({ query: uri.query });
		},
		set html(value) { htmlReady(value); },
	},
};

// Small, valid two-page PDF with a non-white mark and text on each page.
function fixture() {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 550] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 550 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		...['First page', 'Second page'].map(text => {
			const stream = `0.1 0.3 0.8 rg 40 40 100 80 re f BT /F1 24 Tf 40 300 Td (${text}) Tj ET`;
			return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
		}),
	];
	let output = '%PDF-1.7\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(output));
		output += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
	return Buffer.from(output + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

before(async () => {
	const vscode = {
		Uri: { joinPath: Utils.joinPath }, RelativePattern: class { },
		l10n: { t: text => text },
		workspace: {
			fs: { stat: async () => ({ size: fixture().length }) },
			createFileSystemWatcher: () => ({ dispose() { }, onDidChange: noopEvent, onDidDelete: noopEvent }),
		},
		window: { registerCustomEditorProvider: (viewType, value) => {
			assert.equal(viewType, 'vscode.pdfPreview');
			provider = value;
			return { dispose() { } };
		} },
	};
	const bundle = await build({ entryPoints: [path.join(root, 'src/pdfPreview.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
	const module = { exports: {} };
	new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(name => { assert.equal(name, 'vscode'); return vscode; }, module, module.exports);
	module.exports.registerPdfPreviewSupport({ extensionUri: URI.file(root) }, { show() { }, hide() { } });
	server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url, origin);
			if (url.pathname.endsWith('/pdf.worker.js') && request.headers['sec-fetch-dest'] !== 'empty') {
				// Like a webview resource bridge, only the document can fetch this
				// bundle. Worker-side imports cannot reach extension resources.
				response.writeHead(403).end('Fetch the worker bundle from the document');
			} else if (url.pathname === '/') {
				const html = new Promise(resolve => { htmlReady = resolve; });
				const document = await provider.openCustomDocument(URI.file('/workspace/report ü.PDF').with({ query: url.search.slice(1) }));
				await provider.resolveCustomEditor(document, panel);
				response.setHeader('Content-Type', 'text/html');
				response.end(await html);
			} else if (url.pathname === '/favicon.ico') {
				response.writeHead(204).end();
			} else if (url.pathname === '/document.pdf') {
				response.setHeader('Content-Type', 'application/pdf');
				response.end(url.search.includes('invalid') ? Buffer.from('invalid pdf') : url.search.includes('password') ? await readFile(path.join(root, 'test/fixtures/password.pdf')) : fixture());
			} else {
				const file = path.resolve(root, 'pdf-preview-out', decodeURIComponent(url.pathname.slice('/assets/'.length)));
				assert.ok(file.startsWith(path.join(root, 'pdf-preview-out') + path.sep));
				const contentType = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }[path.extname(file)] ?? 'application/octet-stream';
				response.setHeader('Content-Type', contentType);
				response.end(await readFile(file));
			}
		} catch (error) {
			response.writeHead(500).end(String(error));
		}
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ executablePath: process.env.PDF_TEST_BROWSER });
});

after(async () => {
	await browser?.close();
	await new Promise(resolve => server?.close(resolve));
});

async function open(url = '/', viewport = { width: 800, height: 700 }) {
	const page = await browser.newPage({ viewport });
	page.on('console', message => { if (process.env.PDF_TEST_DEBUG) { console.log(message.type(), message.text()); } });
	await page.addInitScript(() => {
		window.acquireVsCodeApi = () => ({
			getState: () => JSON.parse(sessionStorage.getItem('pdf-state') ?? 'null'),
			setState: state => sessionStorage.setItem('pdf-state', JSON.stringify(state)),
		});
	});
	await page.goto(origin + url);
	return page;
}

async function ready(page, text) {
	await expect(page.locator('#viewport')).toHaveAttribute('aria-busy', 'false');
	await expect(page.locator('#status')).toBeHidden();
	await expect(page.locator('.textLayer')).toContainText(text);
}

test('renders PDF pixels and selectable text under the production CSP, fully offline', async () => {
	const page = await open();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await ready(page, 'First page');
	assert.equal(page.workers().length, 1);
	assert.ok(page.workers()[0].url().startsWith('blob:'));
	assert.equal(await page.locator('#page-count').textContent(), '/ 2');
	const pixels = await page.locator('#page canvas').evaluate(canvas => {
		const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
		return data.some((value, index) => index % 4 !== 3 && value < 200);
	});
	assert.equal(pixels, true);
	const textBounds = await page.locator('.textLayer').boundingBox();
	assert.ok(textBounds.width > 300 && textBounds.height > 300);
	assert.deepEqual(errors, []);
	if (process.env.PDF_TEST_SCREENSHOT) { await page.screenshot({ path: process.env.PDF_TEST_SCREENSHOT }); }
	await page.close();
});

test('navigates pages, clamps page numbers, and handles rapid changes', async () => {
	const page = await open();
	await ready(page, 'First page');
	await expect(page.locator('#previous')).toBeDisabled();
	await page.locator('#next').click();
	await ready(page, 'Second page');
	await expect(page.locator('#next')).toBeDisabled();
	await page.locator('#page-number').fill('999');
	await page.locator('#page-number').dispatchEvent('change');
	await expect(page.locator('#page-number')).toHaveValue('2');
	await page.evaluate(() => {
		const input = document.getElementById('page-number');
		for (const value of ['1', '2', '1', '2']) {
			input.value = value;
			input.dispatchEvent(new Event('change'));
		}
	});
	await ready(page, 'Second page');
	await page.close();
});

test('zooms, rotates, fits narrow panels, and restores state after reload', async () => {
	const page = await open('/', { width: 360, height: 640 });
	await ready(page, 'First page');
	const beforeZoom = await page.locator('#page canvas').boundingBox();
	await page.locator('#zoom-in').click();
	await ready(page, 'First page');
	assert.ok((await page.locator('#page canvas').boundingBox()).width > beforeZoom.width);
	await page.locator('#rotate').click();
	await ready(page, 'First page');
	let bounds = await page.locator('#page canvas').boundingBox();
	assert.ok(bounds.width > bounds.height);
	await page.locator('#fit').click();
	await ready(page, 'First page');
	bounds = await page.locator('#page canvas').boundingBox();
	assert.ok(bounds.width <= 328);
	await page.reload();
	await ready(page, 'First page');
	bounds = await page.locator('#page canvas').boundingBox();
	assert.ok(bounds.width > bounds.height && bounds.width <= 328);
	await page.close();
});

test('shows an actionable error for invalid PDFs', async () => {
	const page = await open('/?invalid');
	await expect(page.locator('#status')).toContainText('Unable to open this PDF');
	await expect(page.locator('#next')).toBeDisabled();
	await page.close();
});

test('unlocks an encrypted PDF after retrying an incorrect password', async () => {
	const page = await open('/?password');
	await expect(page.locator('#password-prompt')).toBeVisible();
	await page.locator('#password').fill('wrong');
	await page.locator('#unlock').click();
	await expect(page.locator('#password-label')).toContainText('Incorrect password');
	await page.locator('#password').fill('preview-test');
	await page.locator('#password').press('Enter');
	await expect(page.locator('#password-prompt')).toBeHidden();
	await expect(page.locator('#status')).toBeHidden();
	await expect(page.locator('#page canvas')).toBeVisible();
	await expect(page.locator('#page-count')).toHaveText('/ 1');
	assert.equal(await page.locator('#password').inputValue(), '');
	await page.close();
});


test('revisits a rendered page instantly without replacing its canvas', async () => {
	const page = await open();
	await ready(page, 'First page');
	const firstCanvas = await page.locator('#page canvas').elementHandle();
	await page.locator('#next').click();
	await ready(page, 'Second page');
	const switched = await page.evaluate(() => {
		const start = performance.now();
		document.getElementById('previous').click();
		return { duration: performance.now() - start, busy: document.getElementById('viewport').getAttribute('aria-busy') };
	});
	assert.equal(switched.busy, 'false');
	assert.equal(await firstCanvas.evaluate(canvas => canvas === document.querySelector('#page canvas')), true);
	console.log(`Cached page switch: ${switched.duration.toFixed(1)} ms`);
	await firstCanvas.dispose();
	await page.close();
});

test('keeps the toolbar on one compact row in a narrow editor', async () => {
	const page = await open('/', { width: 320, height: 640 });
	await ready(page, 'First page');
	const layout = await page.locator('nav').evaluate(nav => ({ height: nav.getBoundingClientRect().height, width: nav.clientWidth, content: nav.scrollWidth }));
	assert.ok(layout.height <= 42 && layout.content <= layout.width);
	await expect(page.locator('#previous')).toHaveAccessibleName('Previous Page');
	await expect(page.locator('#fit')).toHaveAttribute('aria-pressed', 'true');
	if (process.env.PDF_TEST_SCREENSHOT) { await page.screenshot({ path: process.env.PDF_TEST_SCREENSHOT.replace('.png', '-narrow.png') }); }
	await page.close();
});

test('shows an error promptly when the worker cannot be fetched', async () => {
	const page = await browser.newPage();
	await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {} }); });
	await page.route('**/pdf.worker.js', route => route.fulfill({ status: 404, body: 'Missing worker' }));
	await page.goto(origin);
	await expect(page.locator('#status')).toContainText('Unable to open this PDF');
	await expect(page.locator('#retry')).toBeVisible();
	await page.close();
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getDocument, GlobalWorkerOptions, PasswordResponses, TextLayer, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import './pdfPreview.css';

interface ViewState {
	page: number;
	scale: number;
	fit: boolean;
	rotation: number;
}

interface RenderedPage {
	element: HTMLDivElement;
	scale: number;
	pixels: number;
}

declare function acquireVsCodeApi(): {
	getState(): Partial<ViewState> | undefined;
	setState(state: ViewState): void;
};

const settings: {
	src: string;
	assetRoot: string;
	isGitLfs: boolean;
	loading: string;
	error: string;
	gitLfs: string;
	password: string;
	incorrectPassword: string;
} = JSON.parse(document.getElementById('settings')!.dataset.settings!);

const vscode = acquireVsCodeApi();
const saved = vscode.getState();
const state: ViewState = {
	page: Number.isInteger(saved?.page) ? Math.max(1, saved!.page!) : 1,
	scale: Number.isFinite(saved?.scale) ? Math.max(0.25, Math.min(4, saved!.scale!)) : 1,
	fit: saved?.fit !== false,
	rotation: [0, 90, 180, 270].includes(saved?.rotation ?? -1) ? saved!.rotation! : 0,
};
const viewport = document.getElementById('viewport')!;
const pageHost = document.getElementById('page')!;
const status = document.getElementById('status')!;
const statusPanel = document.getElementById('status-panel')!;
const retry = document.getElementById('retry')!;
const fit = document.getElementById('fit')!;
const pageNumber = document.getElementById('page-number') as HTMLInputElement;
const previous = document.getElementById('previous') as HTMLButtonElement;
const next = document.getElementById('next') as HTMLButtonElement;
const passwordPrompt = document.getElementById('password-prompt')!;
const passwordInput = document.getElementById('password') as HTMLInputElement;
let pdf: PDFDocumentProxy | undefined;
let renderTask: RenderTask | undefined;
let textLayer: TextLayer | undefined;
let generation = 0;
let requestedKey: string | undefined;
let displayedScale = 1;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

// Keep recent pages ready without retaining a canvas for every page in a large PDF.
const pageCache = new Map<string, RenderedPage>();

function showStatus(message: string, error = false): void {
	clearTimeout(statusTimer);
	status.textContent = message;
	status.hidden = !message;
	statusPanel.hidden = !message;
	statusPanel.classList.toggle('error', error);
	retry.hidden = !error;
}

function showLoading(): void {
	viewport.setAttribute('aria-busy', 'true');
	clearTimeout(statusTimer);
	if (!pageHost.childElementCount) {
		showStatus(settings.loading);
	} else {
		// Fast page switches should not flash a spinner or shift the document.
		statusTimer = setTimeout(() => showStatus(settings.loading), 200);
	}
}

function displayPage(page: RenderedPage): void {
	pageHost.style.width = page.element.style.width;
	pageHost.style.height = page.element.style.height;
	pageHost.replaceChildren(page.element);
	displayedScale = page.scale;
	document.getElementById('zoom-level')!.textContent = `${Math.round(page.scale * 100)}%`;
	viewport.setAttribute('aria-busy', 'false');
	showStatus('');
}

function cachePage(key: string, page: RenderedPage): void {
	pageCache.set(key, page);
	let pixels = [...pageCache.values()].reduce((sum, page) => sum + page.pixels, 0);
	while (pageCache.size > 1 && (pageCache.size > 3 || pixels > 16_777_216)) {
		const oldest = pageCache.keys().next().value!;
		const removed = pageCache.get(oldest)!;
		pixels -= removed.pixels;
		pageCache.delete(oldest);
		// Release the backing surface immediately, rather than waiting for GC.
		const canvas = removed.element.querySelector('canvas');
		if (canvas) {
			canvas.width = canvas.height = 0;
		}
	}
}

async function render(): Promise<void> {
	if (!pdf || disposed || viewport.clientWidth === 0) {
		return;
	}
	const key = `${state.page}:${state.fit ? viewport.clientWidth : state.scale}:${state.fit}:${state.rotation}:${window.devicePixelRatio}`;
	if (requestedKey === key) {
		return;
	}
	requestedKey = key;
	const current = ++generation;
	renderTask?.cancel();
	textLayer?.cancel();
	pageNumber.value = String(state.page);
	previous.disabled = state.page <= 1;
	next.disabled = state.page >= pdf.numPages;
	fit.setAttribute('aria-pressed', String(state.fit));
	vscode.setState(state);
	const cached = pageCache.get(key);
	if (cached) {
		pageCache.delete(key);
		pageCache.set(key, cached);
		displayPage(cached);
		return;
	}
	showLoading();
	try {
		const page = await pdf.getPage(state.page);
		if (current !== generation) {
			return;
		}
		const baseViewport = page.getViewport({ scale: 1, rotation: (page.rotate + state.rotation) % 360 });
		const scale = state.fit ? Math.max(0.1, (viewport.clientWidth - 32) / baseViewport.width) : state.scale;
		const pageViewport = page.getViewport({ scale, rotation: baseViewport.rotation });
		const canvas = document.createElement('canvas');
		const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_777_216 / (pageViewport.width * pageViewport.height)));
		canvas.width = Math.floor(pageViewport.width * ratio);
		canvas.height = Math.floor(pageViewport.height * ratio);
		canvas.style.width = `${pageViewport.width}px`;
		canvas.style.height = `${pageViewport.height}px`;
		const textContainer = document.createElement('div');
		textContainer.className = 'textLayer';
		const element = document.createElement('div');
		element.className = 'pdf-page';
		element.style.width = `${pageViewport.width}px`;
		element.style.height = `${pageViewport.height}px`;
		element.style.setProperty('--total-scale-factor', String(scale * page.userUnit));
		element.append(canvas, textContainer);
		const rendered = { element, scale, pixels: canvas.width * canvas.height };
		renderTask = page.render({ canvas, viewport: pageViewport, transform: [ratio, 0, 0, ratio, 0, 0] });
		await renderTask.promise;
		if (current !== generation) {
			return;
		}
		// Paint first; text extraction should not delay seeing the page.
		displayPage(rendered);
		textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textContainer, viewport: pageViewport });
		await textLayer.render();
		if (current === generation) {
			cachePage(key, rendered);
		}
	} catch (error) {
		if (current === generation) {
			requestedKey = undefined;
			viewport.setAttribute('aria-busy', 'false');
			console.error('Error rendering PDF page', error);
			showStatus(settings.error, true);
		}
	}
}

function goToPage(page: number): void {
	if (pdf && Number.isInteger(page)) {
		state.page = Math.max(1, Math.min(pdf.numPages, page));
		pageNumber.value = String(state.page);
		viewport.scrollTop = 0;
		void render();
	} else {
		pageNumber.value = String(state.page);
	}
}

previous.addEventListener('click', () => goToPage(state.page - 1));
next.addEventListener('click', () => goToPage(state.page + 1));
pageNumber.addEventListener('change', () => goToPage(pageNumber.valueAsNumber));
viewport.addEventListener('keydown', event => {
	if (event.key === 'PageDown' || event.key === 'PageUp') {
		event.preventDefault();
		goToPage(state.page + (event.key === 'PageDown' ? 1 : -1));
	}
});

function zoom(factor: number): void {
	const current = state.fit ? displayedScale : state.scale;
	state.scale = Math.max(0.25, Math.min(4, current * factor));
	state.fit = false;
	void render();
}

document.getElementById('zoom-in')!.addEventListener('click', () => zoom(1.25));
document.getElementById('zoom-out')!.addEventListener('click', () => zoom(0.8));
fit.addEventListener('click', () => { state.fit = true; void render(); });
document.getElementById('rotate')!.addEventListener('click', () => { state.rotation = (state.rotation + 90) % 360; void render(); });
let resizeFrame = 0;
let lastWidth = 0;
const resizeObserver = new ResizeObserver(() => {
	const width = viewport.clientWidth;
	if (width !== lastWidth && width > 0 && (state.fit || !pageHost.childElementCount)) {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => { void render(); });
	}
	lastWidth = width;
});
resizeObserver.observe(viewport);

let loadingTask: PDFDocumentLoadingTask | undefined;
let worker: Worker | undefined;
let workerUrl: string | undefined;
const workerFetch = new AbortController();
let submitPassword: ((password: string) => void) | undefined;
function unlock(): void {
	if (submitPassword) {
		const password = passwordInput.value;
		passwordInput.value = '';
		passwordPrompt.hidden = true;
		submitPassword(password);
		submitPassword = undefined;
		showStatus(settings.loading);
	}
}
passwordInput.addEventListener('keydown', event => { if (event.key === 'Enter') { unlock(); } });
document.getElementById('unlock')!.addEventListener('click', unlock);

async function load(): Promise<void> {
	if (settings.isGitLfs) {
		showStatus(settings.gitLfs);
		statusPanel.querySelector('.loading-spinner')?.setAttribute('hidden', '');
		return;
	}
	try {
		// Webview resource URLs are served by its service worker. A worker cannot
		// import those URLs directly: fetch the entire bundle here and use a blob.
		const response = await fetch(`${settings.assetRoot}pdf.worker.js`, { signal: workerFetch.signal });
		if (!response.ok) {
			throw new Error(`Unable to load PDF worker: ${response.status}`);
		}
		const source = await response.blob();
		if (disposed) {
			return;
		}
		workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		worker = new Worker(workerUrl, { type: 'module', name: 'pdf-preview' });
		GlobalWorkerOptions.workerPort = worker;
		worker.addEventListener('error', () => {
			if (!disposed) {
				showStatus(settings.error, true);
				void loadingTask?.destroy();
			}
		});
		loadingTask = getDocument({
			url: settings.src,
			cMapUrl: `${settings.assetRoot}cmaps/`,
			cMapPacked: true,
			standardFontDataUrl: `${settings.assetRoot}standard_fonts/`,
			wasmUrl: `${settings.assetRoot}wasm/`,
			iccUrl: `${settings.assetRoot}iccs/`,
			// Keep all resource requests in the webview's service-worker context.
			useWorkerFetch: false,
		});
		loadingTask.onPassword = (callback: (password: string) => void, reason: number) => {
			submitPassword = callback;
			showStatus('');
			document.getElementById('password-label')!.textContent = reason === PasswordResponses.INCORRECT_PASSWORD ? settings.incorrectPassword : settings.password;
			passwordPrompt.hidden = false;
			passwordInput.focus();
		};
		pdf = await loadingTask.promise;
		if (disposed) {
			return;
		}
		state.page = Math.min(state.page, pdf.numPages);
		pageNumber.max = String(pdf.numPages);
		document.getElementById('page-count')!.textContent = `/ ${pdf.numPages}`;
		document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('nav button, nav input').forEach(control => { control.disabled = false; });
		await render();
	} catch (error) {
		if (!disposed) {
			console.error('Error loading PDF', error);
			showStatus(settings.error, true);
		}
	}
}

retry.addEventListener('click', () => window.location.reload());
void load();

window.addEventListener('pagehide', () => {
	disposed = true;
	++generation;
	clearTimeout(statusTimer);
	cancelAnimationFrame(resizeFrame);
	resizeObserver.disconnect();
	workerFetch.abort();
	renderTask?.cancel();
	textLayer?.cancel();
	pageCache.clear();
	void loadingTask?.destroy();
	worker?.terminate();
	if (workerUrl) {
		URL.revokeObjectURL(workerUrl);
	}
});

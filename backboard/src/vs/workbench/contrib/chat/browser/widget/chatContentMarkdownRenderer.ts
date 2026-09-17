/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, reset } from '../../../../../base/browser/dom.js';
import { IRenderedMarkdown, MarkdownRenderOptions } from '../../../../../base/browser/markdownRenderer.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IMarkdownRenderer, IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import product from '../../../../../platform/product/common/product.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { AGENT_HOST_SCHEME } from '../../../../../platform/agentHost/common/agentHostUri.js';

const BACKBOARD_GENERATED_IMAGE_HOST = 'backboard-prod.s3.ca-central-1.amazonaws.com';
/**
 * Backboard stores artifacts under a singular folder name (`generated-image/`,
 * `generated-video/`), while older payloads and the project folders use the
 * plural form; accept both so a stored clip still renders.
 */
const BACKBOARD_GENERATED_IMAGE_PATH = /^\/generated-images?\//;
const BACKBOARD_GENERATED_VIDEO_PATH = /^\/generated-videos?\//;
const generatedVideoExtension = /\.(?:mp4|webm|mov|m4v)$/i;

/** Resolve agent-authored relative media against its session, not the app page. */
export function withChatMarkdownBaseUri(markdown: IMarkdownString, workingDirectory: URI | undefined): IMarkdownString {
	if (markdown.baseUri || !workingDirectory) {
		return markdown;
	}
	return {
		...markdown,
		baseUri: workingDirectory.with({ path: `${workingDirectory.path.replace(/\/$/, '')}/` }),
	};
}

/**
 * Keep chat's remote-image privacy boundary intact while allowing images
 * produced by Backboard itself. Restricting both host and path prevents an
 * arbitrary remote markdown image from becoming a tracking request.
 */
export function isBackboardGeneratedImage(uri: URI): boolean {
	return uri.scheme === Schemas.https
		&& uri.authority.toLocaleLowerCase() === BACKBOARD_GENERATED_IMAGE_HOST
		&& BACKBOARD_GENERATED_IMAGE_PATH.test(uri.path);
}

/** Generated clips live in their own bucket folder; see the video tool docs. */
export function isBackboardGeneratedVideo(uri: URI): boolean {
	return uri.scheme === Schemas.https
		&& uri.authority.toLocaleLowerCase() === BACKBOARD_GENERATED_IMAGE_HOST
		&& BACKBOARD_GENERATED_VIDEO_PATH.test(uri.path);
}

/**
 * Keeps the remote-image privacy boundary intact while allowing media produced
 * by Backboard itself, plus the local copies an agent saved into the workspace.
 */
function isPlayableClip(uri: URI): boolean {
	if (isBackboardGeneratedVideo(uri)) {
		return true;
	}
	const isLocal = uri.scheme === Schemas.file
		|| uri.scheme === Schemas.vscodeFileResource
		|| uri.scheme === Schemas.vscodeRemoteResource;
	return isLocal && generatedVideoExtension.test(uri.path);
}

/** Both generated media kinds are allowed past the remote-image barrier. */
export function isBackboardGeneratedMedia(uri: URI): boolean {
	return isBackboardGeneratedImage(uri) || isBackboardGeneratedVideo(uri);
}

const nonPlainTextMarkdownSyntax = /[\\`*_[\]<>|&$~]/;
const gfmAutolink = /\b(?:https?:\/\/|www\.)/i;
const blockMarkdownSyntax = /(^|\n)\s{0,3}(?:#{1,6}\s|>\s?|[-+]\s|\d+[.)]\s|---+\s*$)/;

function renderPlainTextMarkdown(markdown: IMarkdownString, outElement?: HTMLElement): IRenderedMarkdown | undefined {
	const value = markdown.value;
	if (!value || value.includes('\n') || nonPlainTextMarkdownSyntax.test(value) || gfmAutolink.test(value) || blockMarkdownSyntax.test(value)) {
		return undefined;
	}

	const element = outElement ?? $('div');
	element.classList.add('rendered-markdown');
	reset(element, $('p', undefined, value.length > 100_000 ? `${value.substr(0, 100_000)}…` : value));
	return {
		element,
		dispose: () => { }
	};
}

export const allowedChatMarkdownHtmlTags = Object.freeze([
	'b',
	'blockquote',
	'br',
	'code',
	'del',
	'em',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'i',
	'ins',
	'li',
	'ol',
	'p',
	'pre',
	's',
	'strong',
	'sub',
	'sup',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'ul',
	'a',
	'img',

	// TODO@roblourens when we sanitize attributes in markdown source, we can ban these elements at that step. microsoft/vscode-copilot#5091
	// Not in the official list, but used for codicons and other vscode markdown extensions
	'span',
	'div',

	'input', // Allowed for rendering checkboxes. Other types of inputs are removed and the inputs are always disabled
]);

export function getChatMarkdownRenderOptions(options?: MarkdownRenderOptions): MarkdownRenderOptions {
	return {
		...options,
		sanitizerConfig: {
			replaceWithPlaintext: true,
			allowedTags: {
				override: allowedChatMarkdownHtmlTags,
			},
			...options?.sanitizerConfig,
			allowedLinkSchemes: { augment: [product.urlProtocol, 'copilot-skill', Schemas.vscodeBrowser, AGENT_HOST_SCHEME] },
			remoteImageIsAllowed: isBackboardGeneratedMedia,
		}
	};
}

/**
 * This wraps the MarkdownRenderer and applies sanitizer options needed for chat content.
 */
export class ChatContentMarkdownRenderer implements IMarkdownRenderer {
	constructor(
		@ILanguageService languageService: ILanguageService,
		@IOpenerService openerService: IOpenerService,
		@IConfigurationService configurationService: IConfigurationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
	) { }

	render(markdown: IMarkdownString, options?: MarkdownRenderOptions, outElement?: HTMLElement): IRenderedMarkdown {
		const plainTextResult = renderPlainTextMarkdown(markdown, outElement);
		if (plainTextResult) {
			return plainTextResult;
		}

		options = getChatMarkdownRenderOptions(options);

		const mdWithBody: IMarkdownString = (markdown && markdown.supportHtml) ?
			{
				...markdown,

				// dompurify uses DOMParser, which strips leading comments. Wrapping it all in 'body' prevents this.
				// The \n\n prevents marked.js from parsing the body contents as just text in an 'html' token, instead of actual markdown.
				value: `<body>\n\n${markdown.value}\n\n</body>`,
			}
			: markdown;
		const result = this.markdownRendererService.render(mdWithBody, options, outElement);

		// In some cases, the renderer can return top level text nodes  but our CSS expects
		// all text to be in a <p> for margin to be applied properly.
		// So just normalize it.
		result.element.normalize();
		for (const child of result.element.childNodes) {
			if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
				child.replaceWith($('p', undefined, child.textContent));
			}
		}
		return this.attachCustomHover(this.upgradeGeneratedVideos(result));
	}

	/**
	 * Backboard returns generated videos as markdown image syntax. Swap those
	 * nodes for a real player so a clip is watchable inline instead of rendering
	 * as a broken bitmap. Only Backboard-hosted clips and local files are
	 * upgraded: arbitrary remote media stays behind the sanitizer's barrier.
	 */
	private upgradeGeneratedVideos(result: IRenderedMarkdown): IRenderedMarkdown {
		for (const image of [...result.element.querySelectorAll('img')]) {
			const src = image.getAttribute('src');
			if (!src) { continue; }
			let uri: URI;
			try {
				uri = URI.parse(src);
			} catch {
				continue;
			}
			if (!isPlayableClip(uri)) { continue; }
			const playableSrc = FileAccess.uriToBrowserUri(uri).toString(true);
			const video = $('video.generated-video', {
				controls: 'true',
				preload: 'metadata',
				playsinline: 'true',
				src: playableSrc,
			});
			const label = image.getAttribute('alt');
			if (label) { video.setAttribute('aria-label', label); }
			image.replaceWith(video);
		}
		return result;
	}

	private attachCustomHover(result: IRenderedMarkdown): IRenderedMarkdown {
		const store = new DisposableStore();
		// eslint-disable-next-line no-restricted-syntax
		result.element.querySelectorAll('a').forEach((element) => {
			if (element.title) {
				const title = element.title;
				element.title = '';
				store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), element, title));
			}
		});

		return {
			element: result.element,
			dispose: () => {
				result.dispose();
				store.dispose();
			}
		};
	}
}

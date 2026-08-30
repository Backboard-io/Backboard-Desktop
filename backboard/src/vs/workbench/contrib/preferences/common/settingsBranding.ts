/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Display-layer debranding for settings text. Setting descriptions come from
 * hundreds of registration sites (core and built-in extensions), many of which
 * mention VS Code by name or link to its documentation. Rather than chasing
 * every registration, the settings editor sanitizes what it renders:
 *
 *  - links to VS Code documentation are redirected to the Backboard docs;
 *  - all other VS Code / Microsoft links are unlinked (label kept, URL dropped);
 *  - textual "VS Code" / "Visual Studio Code" references become the product name.
 */

import product from '../../../../platform/product/common/product.js';

const BACKBOARD_DOCS_URL = 'https://docs.backboard.io';

/** Markdown links whose target is VS Code documentation. */
const DOCS_LINK_PATTERN = /\(https?:\/\/code\.visualstudio\.com\/(?:docs|api|learn|updates)[^)\s]*\)/gi;

/** Markdown links to any other VS Code / Microsoft property: keep the label, drop the link. */
const OTHER_LINK_PATTERN = /\[([^\]]*)\]\(https?:\/\/(?:[^)\s]*\.)?(?:visualstudio\.com|aka\.ms|go\.microsoft\.com|microsoft\.com)[^)]*\)/gi;

/** Bare (non-markdown) URLs to VS Code documentation → Backboard docs. */
const BARE_DOCS_LINK_PATTERN = /https?:\/\/code\.visualstudio\.com\/(?:docs|api|learn|updates)[^\s)\]]*/gi;

/** Bare URLs to any other VS Code property are removed outright. */
const BARE_OTHER_LINK_PATTERN = /https?:\/\/(?:[^\s)\]]*\.)?visualstudio\.com[^\s)\]]*/gi;

/** Textual product references, longest form first so substrings don't half-match. */
const BRAND_TEXT_PATTERN = /Visual Studio Code(?: - Insiders)?|VS Code|VSCode/g;

export function sanitizeSettingsText(text: string, productName: string = product.nameLong): string {
	if (!text) {
		return text;
	}
	return text
		.replace(DOCS_LINK_PATTERN, `(${BACKBOARD_DOCS_URL})`)
		.replace(OTHER_LINK_PATTERN, '$1')
		.replace(BARE_DOCS_LINK_PATTERN, BACKBOARD_DOCS_URL)
		.replace(BARE_OTHER_LINK_PATTERN, '')
		.replace(BRAND_TEXT_PATTERN, productName);
}

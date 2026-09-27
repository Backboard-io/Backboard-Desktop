/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../../../base/browser/window.js';
import { FileAccess } from '../../../../../../../base/common/network.js';

/**
 * Codex's 28 agent avatar glyphs, in the app's own index order (SPEC §7.1).
 * Each has a dark and a light SVG under `widget/media/codexAvatars/`.
 */
const AVATARS = [
	'00-apricot', '01-bloom', '02-clear-sky', '03-coral-pop', '04-teal', '05-lavender', '06-mint', '07-sprout',
	'08-sunbeam', '09-violet', '10-sunbeam-2', '11-apricot-pinwheel', '12-coral-pop-knot', '13-bloom-rosette',
	'14-violet-1', '15-clear-sky-2', '16-sprout-2', '17-teal-2', '18-lavender-2', '19-sunbeam-halo',
	'20-coral-pop-clover', '21-bloom-orbit', '22-violet-2', '23-clear-sky-1', '24-sprout-bud', '25-mint-2',
	'26-teal-1', '27-lavender-1',
] as const;

const HASH_MODULUS = 2147483647;

/** Codex's avatar index: `h = (h * 31 + charCode) % 2147483647` over the agent's thread id. */
export function codexAvatarIndex(seed: string): number {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) {
		hash = (hash * 31 + seed.charCodeAt(i)) % HASH_MODULUS;
	}
	return hash % AVATARS.length;
}

/** Name of one of Codex's avatar glyphs, e.g. `'13-bloom-rosette'`. */
export type CodexAvatarName = typeof AVATARS[number];

/** `<img class="size-3.5 shrink-0 …">` showing the seeded glyph for the current theme. */
export function codexAgentAvatar(seed: string, light: boolean, className = ''): HTMLImageElement {
	return codexAvatarImage(AVATARS[codexAvatarIndex(seed)], light, `size-3.5 shrink-0${className ? ` ${className}` : ''}`);
}

/** A specific avatar glyph, for surfaces that want a fixed identity instead of a seeded one. */
export function codexAvatarImage(name: CodexAvatarName, light: boolean, className = ''): HTMLImageElement {
	const img = mainWindow.document.createElement('img');
	img.className = className;
	img.alt = '';
	img.draggable = false;
	img.src = FileAccess.asBrowserUri(`vs/workbench/contrib/chat/browser/widget/media/codexAvatars/${name}-${light ? 'light' : 'dark'}.svg`).toString(true);
	return img;
}

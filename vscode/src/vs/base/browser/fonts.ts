/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from './window.js';
import type { IJSONSchemaSnippet } from '../common/jsonSchema.js';
import { isElectron } from '../common/platform.js';

/**
 * Backboard's default UI font. The font-face is registered as "BB Mono" in
 * the workbench stylesheet and backed by IBM Plex Mono assets.
 */
export const DEFAULT_FONT_FAMILY = '"BB Mono", monospace';

interface FontData {
	readonly family: string;
}

export const getFonts = async (): Promise<string[]> => {
	try {
		// @ts-ignore
		const fonts = await mainWindow.queryLocalFonts() as FontData[];
		const fontsArray = [...fonts];
		const families = fontsArray.map(font => font.family);
		return families;
	} catch (error) {
		console.error(`Failed to query fonts: ${error}`);
		return [];
	}
};


export const getFontSnippets = async (): Promise<IJSONSchemaSnippet[]> => {
	if (!isElectron) {
		return [];
	}
	const fonts = await getFonts();
	const snippets: IJSONSchemaSnippet[] = fonts.map(font => {
		return {
			body: `${font}`
		};
	});
	return snippets;
};

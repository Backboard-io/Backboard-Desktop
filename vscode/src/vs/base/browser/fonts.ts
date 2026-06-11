/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from './window.js';
import type { IJSONSchemaSnippet } from '../common/jsonSchema.js';
import { isElectron, isMacintosh, isWindows } from '../common/platform.js';

/**
 * The best font-family to be used in CSS:
 * - IBM Plex Sans preferred
 * - platform UI fonts retained as fallbacks
 *
 * Note: this currently does not adjust for different locales.
 */
export const DEFAULT_FONT_FAMILY = isWindows ? '"IBM Plex Sans", "Segoe WPC", "Segoe UI", sans-serif' : isMacintosh ? '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif' : '"IBM Plex Sans", system-ui, "Ubuntu", "Droid Sans", sans-serif';

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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spans the workbench injects into user prompts as model-only context. The
 * customizations index rides along as a `<skills>…</skills>` block and file
 * references as a `<system-reminder>…</system-reminder>` block; neither is
 * user-authored text.
 */
const INJECTED_BLOCK_PATTERNS = [
	/<skills>[\s\S]*?<\/skills>/g,
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
];

/**
 * Strips workbench-injected context blocks from a user-message text that is
 * being reconstructed for DISPLAY (session replay, turn-start echo). The
 * blocks must still be SENT to the model — this only keeps them out of the
 * rendered conversation, where they show up as a wall of raw XML attached
 * to the user's message.
 *
 * Also handles transcripts written before the injected blocks were split
 * into their own content items, where the block is embedded in the same
 * string as the user's prompt.
 */
export function stripInjectedContextBlocks(text: string): string {
	let out = text;
	for (const pattern of INJECTED_BLOCK_PATTERNS) {
		out = out.replace(pattern, '');
	}
	// Collapse the blank runs left behind by removed blocks.
	return out.replace(/\n{3,}/g, '\n\n').trim();
}

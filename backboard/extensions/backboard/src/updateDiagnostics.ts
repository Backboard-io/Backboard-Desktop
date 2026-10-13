/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Keep the underlying failure instead of the installer's generic EXIT-trap footer. */
export function updatePreparationFailure(log: string, logPath: string): string {
	const lines = log.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	while (lines.length && /^(?:\[[^\]]+\]\s*)?Update failed for Backboard Studio\b/.test(lines.at(-1)!)) {
		lines.pop();
	}
	const detail = lines.slice(-4).join(' | ').slice(-1200);
	return `Update preparation failed${detail ? `: ${detail}` : '.'} Full log: ${logPath}`;
}

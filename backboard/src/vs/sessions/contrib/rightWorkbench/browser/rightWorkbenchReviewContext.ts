/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function createRightWorkbenchReviewContextKey(sessionKey: string | undefined, chatKey: string | undefined): string | undefined {
	return sessionKey ? `${sessionKey}\0${chatKey ?? ''}` : undefined;
}

/**
 * Invalidates deferred Review work whenever the visible session/chat changes.
 * The generation is deliberately independent from the resource key so hiding
 * and re-showing the pane can also invalidate an in-flight editor open.
 */
export class RightWorkbenchReviewContext {

	private contextKey: string | undefined;
	private generation = 0;

	transition(contextKey: string | undefined): boolean {
		if (this.contextKey === contextKey) {
			return false;
		}

		this.contextKey = contextKey;
		this.generation++;
		return true;
	}

	invalidate(): void {
		this.generation++;
	}

	captureGeneration(): number {
		return this.generation;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}
}

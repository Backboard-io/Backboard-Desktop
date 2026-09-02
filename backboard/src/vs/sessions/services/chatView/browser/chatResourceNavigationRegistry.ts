/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';

export interface IChatResourceNavigationContext {
	readonly title: string;
	readonly agentName?: string;
	readonly status?: string;
}

/**
 * A chat surface outside the SessionsPart that can temporarily display child
 * resources (for example the Editor mode chat in the right workbench).
 */
export interface IChatResourceNavigationParticipant {
	/** Whether this surface currently owns the chat that launched the child. */
	canHandleChatResource(parentSessionResource: URI): boolean;
	/** Open a child resource in place and remember its parent. */
	openChatResource(parentSessionResource: URI, chatResource: URI, context?: IChatResourceNavigationContext): Promise<boolean>;
	/** Return to the resource that preceded the currently displayed child. */
	navigateBack(parentSessionResource: URI): Promise<boolean>;
}

/**
 * Routes child-chat navigation to mode-specific chat hosts. Participants are
 * tried newest-first so a visible/recreated surface wins over a stale host
 * that is in the process of being disposed.
 */
export class ChatResourceNavigationRegistry {

	private readonly participants = new Set<IChatResourceNavigationParticipant>();

	registerParticipant(participant: IChatResourceNavigationParticipant): IDisposable {
		this.participants.add(participant);
		return toDisposable(() => this.participants.delete(participant));
	}

	async openChatResource(parentSessionResource: URI, chatResource: URI, context?: IChatResourceNavigationContext): Promise<boolean> {
		for (const participant of Array.from(this.participants).reverse()) {
			if (participant.canHandleChatResource(parentSessionResource)
				&& await participant.openChatResource(parentSessionResource, chatResource, context)) {
				return true;
			}
		}
		return false;
	}

	async navigateBack(parentSessionResource: URI): Promise<boolean> {
		for (const participant of Array.from(this.participants).reverse()) {
			if (participant.canHandleChatResource(parentSessionResource)
				&& await participant.navigateBack(parentSessionResource)) {
				return true;
			}
		}
		return false;
	}
}

export const chatResourceNavigationRegistry = new ChatResourceNavigationRegistry();

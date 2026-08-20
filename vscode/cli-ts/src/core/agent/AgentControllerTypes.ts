import type { TurnStatus } from "../bus/events.ts";

export interface QueuedSubmit {
	text: string;
	emitUserMessage: boolean;
	onStart?: () => void;
	attachmentFilePaths?: string[];
	displayContent?: string;
	conversationContext?: string;
	resolve: (status: TurnStatus) => void;
	reject: (err: unknown) => void;
}

export interface SubmitOptions {
	emitUserMessage?: boolean;
	onStart?: () => void;
	attachmentFilePaths?: string[];
	displayContent?: string;
	/** Prior conversation supplied by a host when creating a new branch. */
	conversationContext?: string;
}

export interface CancelOptions {
	clearQueue?: boolean;
}

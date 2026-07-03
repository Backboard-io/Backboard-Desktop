import type { TurnStatus } from "../bus/events.ts";

export interface QueuedSubmit {
	text: string;
	emitUserMessage: boolean;
	onStart?: () => void;
	resolve: (status: TurnStatus) => void;
	reject: (err: unknown) => void;
}

export interface SubmitOptions {
	emitUserMessage?: boolean;
	onStart?: () => void;
}

export interface CancelOptions {
	clearQueue?: boolean;
}

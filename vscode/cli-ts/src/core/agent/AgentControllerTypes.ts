import type {
	BackboardAudioFile,
	BackboardVoiceConfig,
} from "../../providers/backboard/types.ts";
import type { TurnStatus } from "../bus/events.ts";

export interface QueuedSubmit {
	text: string;
	emitUserMessage: boolean;
	onStart?: () => void;
	voice?: BackboardVoiceConfig;
	audioFile?: BackboardAudioFile;
	resolve: (status: TurnStatus) => void;
	reject: (err: unknown) => void;
}

export interface SubmitOptions {
	emitUserMessage?: boolean;
	onStart?: () => void;
	voice?: BackboardVoiceConfig;
	audioFile?: BackboardAudioFile;
}

export interface CancelOptions {
	clearQueue?: boolean;
}

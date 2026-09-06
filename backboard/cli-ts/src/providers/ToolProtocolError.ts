/** Only adapters that have not released a final tool batch may request this retry. */
export class RetryableToolProtocolError extends Error {
	readonly category = "protocol";
	readonly retryable = true;
	readonly safeToRetryBeforeTools = true;

	constructor(message: string) {
		super(message);
		this.name = "RetryableToolProtocolError";
	}
}

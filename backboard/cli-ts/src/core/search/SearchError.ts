/** Search failures carry execution state separately from the searched text. */
export class SearchError extends Error {
	readonly retryable = false;
	readonly timedOut: boolean;
	readonly cancelled: boolean;

	constructor(
		message: string,
		readonly category:
			| "invalid_argument"
			| "unavailable"
			| "missing_path"
			| "permission"
			| "cancelled"
			| "timeout"
			| "execution",
		readonly code: string,
		readonly exitCode?: number,
	) {
		super(message);
		this.name = "SearchError";
		this.timedOut = category === "timeout";
		this.cancelled = category === "cancelled";
	}
}

export class AbortError extends Error {
	constructor() {
		super("aborted");
		this.name = "AbortError";
	}
}

export function isAbortError(err: unknown): boolean {
	return (
		err instanceof AbortError ||
		(err instanceof Error &&
			(err.name === "AbortError" || err.name === "TimeoutError"))
	);
}

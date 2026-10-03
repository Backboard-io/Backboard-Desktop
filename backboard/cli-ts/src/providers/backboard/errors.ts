export class BackboardError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: unknown,
	) {
		super(message);
		this.name = "BackboardError";
	}
}

export class BackboardTransportError extends Error {
	constructor(
		message: string,
		readonly endpoint: string,
		readonly phase: "request" | "stream",
		readonly originalError: unknown,
	) {
		super(message);
		this.name = "BackboardTransportError";
	}
}

/**
 * "Backboard request failed: HTTP 403: <detail>". The server's `detail` is
 * what tells a refused turn apart (out of credits, sign-in required), so it
 * belongs in the message the agent loop classifies and the user sees.
 */
export function backboardHttpErrorMessage(
	status: number,
	body: unknown,
): string {
	const detail =
		body && typeof body === "object" && "detail" in body
			? (body as { detail?: unknown }).detail
			: undefined;
	const text =
		typeof detail === "string"
			? detail.trim()
			: detail &&
					typeof detail === "object" &&
					"message" in detail &&
					typeof (detail as { message?: unknown }).message === "string"
				? (detail as { message: string }).message.trim()
				: "";
	return text
		? `Backboard request failed: HTTP ${status}: ${text}`
		: `Backboard request failed: HTTP ${status}`;
}

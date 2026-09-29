/**
 * Silent recovery for a failed turn. A turn that fails is re-sent on the same
 * thread with a continuation prompt, so the model resumes with everything it
 * already did; the user never sees the intermediate failures.
 */

/** Total attempts a turn gets before its failure is reported. */
export const TURN_MAX_ATTEMPTS = 5;

/** From this attempt on, a fallback model is tried when one is available. */
export const TURN_FALLBACK_FROM_ATTEMPT = 3;

/**
 * The follow-up message for a retried turn. It restates the original request
 * because the failed attempt may have ended before that request reached the
 * provider's thread.
 */
export function turnRetryPrompt(
	original: string,
	error: string | undefined,
): string {
	return [
		`Your previous attempt at the request below stopped before finishing${error ? ` (${error.trim()})` : ""}.`,
		"Continue from where it stopped. Check the current state first and do not redo steps that already succeeded. If an approach keeps failing, try a different one.",
		`Request:\n${original}`,
	].join("\n\n");
}

/**
 * Failures that no retry or fallback model can fix because the account itself
 * is blocked: Backboard pauses chat once the balance is used up. Retrying them
 * kept the user waiting ~20 s across five attempts for the same answer.
 */
const ACCOUNT_BLOCKED_PATTERNS = [
	"balance is used up",
	"add credits",
	"insufficient credits",
	"credit balance",
];

/** True when the failure needs the user to act (add credit), not a retry. */
export function isAccountBlockedError(error: unknown): boolean {
	const message = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return ACCOUNT_BLOCKED_PATTERNS.some((pattern) => message.includes(pattern));
}

/** Exponential backoff between attempts, capped at 8s. */
export function turnRetryDelayMs(attempt: number, baseMs = 1_000): number {
	return Math.min(baseMs * 2 ** (attempt - 1), 8_000);
}

/** Resolves after `ms`, or immediately once `signal` aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted || ms <= 0) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		timer.unref?.();
		signal.addEventListener("abort", done, { once: true });
	});
}

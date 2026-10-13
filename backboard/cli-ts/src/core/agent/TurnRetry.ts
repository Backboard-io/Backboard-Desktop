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
 * Thrown between tool rounds when the window crossed the compression
 * threshold. The turn loop compresses and resumes the same turn on a fresh
 * thread instead of submitting the round's outputs into the full one.
 */
export class ContextCompactionNeeded extends Error {
	constructor() {
		super("Context window crossed the compression threshold.");
	}
}

/** At most this many compressions inside one turn, so a loop cannot spin. */
export const TURN_MAX_COMPACTIONS = 3;

/**
 * A provider refused the request because the prompt no longer fits. Resending
 * the same thread can never succeed; only compressing it can.
 */
export function isContextOverflowError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context(?: window| length)?|context window (?:is )?(?:full|exceeded)|too many (?:input )?tokens|input (?:is )?too long|request_too_large/i.test(
		message,
	);
}

/**
 * The follow-up message after compressing mid-turn: the resume context above
 * it carries what was done, so the model only needs the request restated.
 */
export function turnContinuePrompt(original: string): string {
	return [
		"Continue working on the request below from where you left off. Check the current state first and do not redo steps that already succeeded.",
		`Request:\n${original}`,
	].join("\n\n");
}

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
 * is blocked: Backboard pauses chat once the balance is used up, and nothing
 * can bill a model once its route is signed out. Retrying them kept the user
 * waiting ~20 s across five attempts for the same answer.
 */
const ACCOUNT_BLOCKED_PATTERNS = [
	"balance is used up",
	"add credits",
	"insufficient credits",
	"credit balance",
	"no backend can serve",
	// A guest (signed-out) key may only run Backboard's free models.
	"sign in to use this model",
];

/**
 * True when the server no longer knows the session's thread. A first message
 * the account could not pay for still hands back a thread id, but the server
 * never keeps that thread, so every later send to it 404s.
 */
export function isThreadNotFoundError(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error))
		.toLowerCase()
		.includes("thread not found");
}

/**
 * A locally stored conversation (subscription or API key) this runtime cannot
 * load. Retries and fallback models repeat the same failure, so the turn fails
 * fast and the host reseeds the chat from its own record.
 */
export function isLostLocalConversationError(error: unknown): boolean {
	return /unknown (?:claude )?subscription (?:conversation|thread)|saved (?:claude )?subscription conversation .* was not found|unknown conversation byok_/i.test(
		error instanceof Error ? error.message : String(error),
	);
}

/** True when the server refused a paid model because nobody is signed in. */
export function isSignInRequiredError(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error))
		.toLowerCase()
		.includes("sign in to use this model");
}

/** True when the failure needs the user to act (add credit, sign in), not a retry. */
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

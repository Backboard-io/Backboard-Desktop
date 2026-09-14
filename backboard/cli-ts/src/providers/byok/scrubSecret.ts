export const REDACTED_SECRET = "<redacted>";

/**
 * Common API-key shapes, matched as a defence in depth for text whose origin
 * we do not control (vendor error bodies, malformed responses, child output).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	// OpenAI, OpenRouter, Anthropic: sk-..., sk-proj-..., sk-or-v1-..., sk-ant-...
	/\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g,
	// Google AI Studio.
	/\bAIza[0-9A-Za-z_-]{20,}/g,
];

/**
 * Removes a known secret, and anything shaped like one, from free text before
 * it reaches a log, an event, or another process. Header redaction is not
 * enough on its own: vendors echo key fragments in error bodies.
 */
export function scrubSecret(
	text: string,
	secret?: string | null,
): string {
	let out = text;
	const trimmed = secret?.trim();
	if (trimmed && trimmed.length >= 4) {
		out = out.split(trimmed).join(REDACTED_SECRET);
		if (secret !== undefined && secret !== null && secret !== trimmed) {
			out = out.split(secret).join(REDACTED_SECRET);
		}
	}
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, REDACTED_SECRET);
	}
	return out;
}

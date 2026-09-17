import type { ByokProviderId } from "../../core/keys/ProviderKeyTypes.ts";
import { errorMessage } from "../../utils/errors.ts";
import { readSseFrames, sseDataPayload } from "../backboard/sse.ts";
import { ByokError, providerErrorMessage } from "./ByokError.ts";
import {
	assertCredentialCurrent,
	type ProviderCredential,
	type ProviderTransport,
} from "./ProviderCredential.ts";
import { scrubSecret } from "./scrubSecret.ts";

export interface ProviderRequest {
	credential?: ProviderCredential;
	transport?: ProviderTransport;
	url: string;
	headers: Record<string, string>;
	body: unknown;
	signal?: AbortSignal;
	provider: ByokProviderId;
}

async function send(request: ProviderRequest): Promise<Response> {
	const options: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json", ...request.headers },
		body: JSON.stringify(request.body),
	};
	if (request.signal) options.signal = request.signal;
	if (request.credential) assertCredentialCurrent(request.credential);
	return (request.transport ?? fetch)(request.url, options);
}

/** The credential values carried by a request, so error text can be scrubbed of them. */
function secretsFromHeaders(headers: Record<string, string>): string[] {
	const secrets: string[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (lower === "authorization") {
			secrets.push(value.replace(/^\s*bearer\s+/i, ""));
		} else if (lower === "x-api-key" || lower === "x-goog-api-key") {
			secrets.push(value);
		}
	}
	return secrets.filter((secret) => secret.trim().length > 0);
}

/** Removes every request credential (and anything key-shaped) from vendor text. */
function scrubAll(text: string, secrets: readonly string[]): string {
	let out = scrubSecret(text);
	for (const secret of secrets) out = scrubSecret(out, secret);
	return out;
}

async function assertOk(
	res: Response,
	provider: ByokProviderId,
	headers: Record<string, string>,
): Promise<void> {
	if (res.ok) return;
	// Vendors echo key fragments in error bodies. Scrub before the text can
	// reach a log, an event, or the IDE.
	const secrets = secretsFromHeaders(headers);
	const text = scrubAll(await res.text().catch(() => ""), secrets);
	const body = safeJson(text);
	const detail = providerErrorMessage(body);
	throw new ByokError(
		detail
			? `${providerLabel(provider)} request failed (HTTP ${res.status}): ${detail}`
			: `${providerLabel(provider)} request failed: HTTP ${res.status}`,
		provider,
		res.status,
		body,
	);
}

/** GETs JSON with the provider's auth headers. */
export async function getJson<T>(
	url: string,
	headers: Record<string, string>,
	provider: ByokProviderId,
	signal?: AbortSignal,
	credential?: ProviderCredential,
	transport: ProviderTransport = fetch,
): Promise<T> {
	const options: RequestInit = { method: "GET", headers };
	if (signal) options.signal = signal;
	if (credential) assertCredentialCurrent(credential);
	const res = await transport(url, options);
	await assertOk(res, provider, headers);
	return (await res.json()) as T;
}

/**
 * POSTs JSON and yields each SSE frame's decoded payload. Frames with no
 * `data:` line, and the `[DONE]` sentinel OpenAI sends, are skipped so adapters
 * only ever see real events.
 */
export async function* postSseJson(
	request: ProviderRequest,
): AsyncIterable<Record<string, unknown>> {
	const res = await send(request);
	await assertOk(res, request.provider, request.headers);
	if (!res.body) {
		throw new ByokError(
			`${providerLabel(request.provider)} stream response had no body`,
			request.provider,
			res.status,
			null,
		);
	}

	for await (const frame of readSseFrames(res.body, {
		includeTransportActivity: true,
	})) {
		const data = sseDataPayload(frame);
		if (data === null) {
			// Adapters translate an empty payload object into the internal
			// ProviderEvent activity marker without surfacing anything in the UI.
			yield {};
			continue;
		}
		// Matched against the extracted payload, never the raw frame: the payload
		// is JSON, so an assistant message that merely *contains* "data: [DONE]"
		// (writing about SSE, say) would otherwise end the stream mid-turn and
		// commit the partial turn as complete.
		if (data === "[DONE]") return;
		let payload: unknown;
		try {
			payload = JSON.parse(data);
		} catch (err) {
			throw new ByokError(
				`Malformed ${providerLabel(request.provider)} stream event: ${scrubAll(errorMessage(err), secretsFromHeaders(request.headers))}`,
				request.provider,
				0,
				scrubAll(frame, secretsFromHeaders(request.headers)),
			);
		}
		if (payload == null) {
			yield {};
			continue;
		}
		if (typeof payload === "object" && !Array.isArray(payload)) {
			const record = payload as Record<string, unknown>;
			// Error payloads are untrusted vendor text, including errors delivered over HTTP 200.
			if (
				record.error ||
				record.type === "error" ||
				record.type === "response.failed" ||
				record.type === "response.incomplete"
			) {
				yield JSON.parse(
					scrubAll(JSON.stringify(record), secretsFromHeaders(request.headers)),
				) as Record<string, unknown>;
			} else {
				yield record;
			}
		} else {
			yield {};
		}
	}
}

function providerLabel(provider: ByokProviderId): string {
	switch (provider) {
		case "anthropic":
			return "Anthropic";
		case "openai":
			return "OpenAI";
		case "xai":
			return "xAI";
		case "google":
			return "Google";
		case "openrouter":
			return "OpenRouter";
	}
}

export function safeJson(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

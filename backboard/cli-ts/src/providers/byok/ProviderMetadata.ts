/* Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. */
import type { ByokProviderId } from "../../core/keys/ProviderKeyTypes.ts";

/** Opaque vendor state is replayable only on the route that produced it. */
export function encodeProviderMetadata(
	provider: ByokProviderId,
	model: string,
	data: unknown,
): string {
	return JSON.stringify({ version: 1, provider, model, data });
}

export function decodeProviderMetadata(
	raw: string | undefined,
	provider: ByokProviderId,
	model: string,
): unknown {
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw);
		if (
			value?.version === 1 &&
			value.provider === provider &&
			value.model === model
		)
			return value.data;
		// Legacy Anthropic records already carried a model binding. Other legacy
		// records remain readable as ordinary history without replaying opaque state.
		if (
			provider === "anthropic" &&
			value?.version === undefined &&
			value?.model === model &&
			Array.isArray(value.thinking)
		)
			return value;
	} catch {
		/* A damaged optional annotation must not lose visible history. */
	}
	return undefined;
}

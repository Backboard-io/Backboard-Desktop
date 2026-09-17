/* Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. */
import type { ByokProviderId } from "../../core/keys/ProviderKeyTypes.ts";

/** A raw key is used only by standalone validation and adapter callers. */
export type ProviderCredential =
	| string
	| {
			readonly key: string;
			readonly generation: number;
			assertCurrent(): void;
	  };

export class CredentialChangedError extends Error {
	readonly retryable = false;
	constructor(provider: ByokProviderId) {
		super(
			`The ${provider} API key changed before this request was sent. Submit the request again.`,
		);
		this.name = "CredentialChangedError";
	}
}

export function credentialKey(credential: ProviderCredential): string {
	return typeof credential === "string" ? credential : credential.key;
}

export function assertCredentialCurrent(credential: ProviderCredential): void {
	if (typeof credential !== "string") credential.assertCurrent();
}

/** Injectable HTTP transport without runtime-specific fetch helper properties. */
export type ProviderTransport = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

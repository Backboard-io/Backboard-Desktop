import type { AgentClient } from "../providers/AgentClient.ts";
import type { ModelSource } from "../providers/backboard/types.ts";
import { CredentialChangedError } from "../providers/byok/ProviderCredential.ts";
import type { Config } from "./Config.ts";
import type { ThinkingConfig } from "./defaults.ts";
import { resolveThinking } from "./defaults.ts";
import type {
	DynamicThinkingEvidence,
	ThinkingIntent,
	ThinkingModelMetadata,
} from "./thinking.types.ts";

export interface RuntimeThinkingResolver {
	intent: ThinkingIntent | null | undefined;
	resolve(evidence: DynamicThinkingEvidence): ThinkingConfig | null | undefined;
}

export async function resolveRuntimeThinking(
	config: Pick<Config, "model" | "thinkingIntent"> & {
		modelSource?: ModelSource;
	},
	client: Pick<AgentClient, "getModelThinkingMetadata">,
	evidence: DynamicThinkingEvidence = {
		phase: "initial",
		requestKind: "user",
	},
): Promise<ThinkingConfig | null | undefined> {
	const resolver = await createRuntimeThinkingResolver(config, client);
	return resolver.resolve(evidence);
}

export async function createRuntimeThinkingResolver(
	config: Pick<Config, "model" | "thinkingIntent"> & {
		modelSource?: ModelSource;
	},
	client: Pick<AgentClient, "getModelThinkingMetadata">,
): Promise<RuntimeThinkingResolver> {
	const intent = config.thinkingIntent;
	const model = config.model;
	const metadata =
		intent === undefined || intent === null
			? null
			: await findModelInfo(client, model, config.modelSource).catch(
					(error) => {
						if (error instanceof CredentialChangedError) throw error;
						return null;
					},
				);
	return {
		intent,
		resolve(evidence) {
			try {
				return resolveThinking({
					intent,
					model,
					metadata,
					dynamicEvidence: evidence,
				});
			} catch {
				// Thinking is an optimization, never a reason to lose the whole turn.
				// A provider may advertise stale or incomplete controls, so degrade to
				// an explicit off value and let the model answer normally.
				return null;
			}
		},
	};
}

async function findModelInfo(
	client: Pick<AgentClient, "getModelThinkingMetadata">,
	model: { provider: string; model: string },
	source?: ModelSource,
): Promise<ThinkingModelMetadata | null> {
	return client.getModelThinkingMetadata(model.provider, model.model, {
		source,
	});
}

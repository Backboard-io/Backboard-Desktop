import { describe, expect, it } from "bun:test";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import type {
	BackboardThread,
	ModelsListResponse,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { ClientRouter } from "../src/providers/ClientRouter.ts";

class RecordingClient {
	readonly messages: SendMessageRequest[] = [];
	readonly sent: SendMessageRequest[] = [];
	readonly toolOutputs: SubmitToolOutputsRequest[] = [];

	constructor(
		readonly name: string,
		readonly capabilities: AgentClient["capabilities"],
		private readonly models: ModelsListResponse["models"] = [],
		readonly threads: BackboardThread[] = [],
	) {}

	async *runMessage(req: SendMessageRequest): AsyncIterable<ProviderEvent> {
		this.messages.push(req);
		yield { kind: "completed" };
	}

	async *runToolOutputs(
		req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		this.toolOutputs.push(req);
		yield { kind: "completed" };
	}

	async sendMessage(req: SendMessageRequest): Promise<unknown> {
		this.sent.push(req);
		return { thread_id: "t", content: "", status: "COMPLETED" };
	}

	async listModels(): Promise<ModelsListResponse> {
		return { models: this.models, total: this.models.length };
	}

	async listThreads(): Promise<BackboardThread[]> {
		return this.threads;
	}

	async getThread(threadId: string): Promise<BackboardThread> {
		const thread = this.threads.find(
			(candidate) => candidate.thread_id === threadId,
		);
		if (!thread) throw new Error(`missing ${threadId}`);
		return thread;
	}
}

function backboard(models: ModelsListResponse["models"] = []): RecordingClient {
	return new RecordingClient(
		"backboard",
		{ assistants: true, threads: true, memory: true },
		models,
	);
}

function byok(models: ModelsListResponse["models"] = []): RecordingClient {
	return new RecordingClient(
		"byok",
		{ assistants: false, threads: false, memory: false },
		models,
	);
}

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<void> {
	for await (const _event of stream) {
		// consume
	}
}

function router(options: {
	backboardClient?: RecordingClient;
	byokClient?: RecordingClient;
	subscriptionClient?: RecordingClient;
	subscriptions?: Record<
		string,
		{ client: RecordingClient; threadPrefix: string }
	>;
	model?: { provider: string; model: string };
	keyed?: string[];
	signedIn?: boolean;
	explicitSources?: boolean;
	modelSource?: "backboard" | "byok" | "subscription";
}): ClientRouter {
	return new ClientRouter({
		...(options.backboardClient
			? { backboard: options.backboardClient as unknown as AgentClient }
			: {}),
		...(options.byokClient
			? { byok: options.byokClient as unknown as AgentClient }
			: {}),
		...(options.subscriptionClient
			? {
					subscription: options.subscriptionClient as unknown as AgentClient,
				}
			: {}),
		...(options.subscriptions
			? {
					subscriptions: Object.fromEntries(
						Object.entries(options.subscriptions).map(([provider, route]) => [
							provider,
							{
								client: route.client as unknown as AgentClient,
								threadPrefix: route.threadPrefix,
							},
						]),
					),
				}
			: {}),
		getModel: () =>
			options.model ?? { provider: "anthropic", model: "claude-opus-5" },
		...(options.signedIn === undefined
			? {}
			: { hasBackboardAuth: () => options.signedIn === true }),
		hasKeyFor: (provider) => (options.keyed ?? []).includes(provider),
		...(options.explicitSources
			? {
					explicitSources: true,
					getModelSource: () => options.modelSource,
				}
			: {}),
	});
}

describe("ClientRouter precedence", () => {
	it("reports thread origin independently of the active model", () => {
		const client = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: ["anthropic"],
		});

		expect(client.sourceForThread("byok_saved")).toBe("byok");
		expect(client.sourceForThread("thread_backboard")).toBe("backboard");
	});

	it("prefers a saved key over Backboard for the same vendor", () => {
		expect(
			router({
				backboardClient: backboard(),
				byokClient: byok(),
				keyed: ["anthropic"],
			}).sourceFor({ provider: "anthropic", model: "claude-opus-5" }),
		).toBe("byok");
	});

	it("routes the explicit subscription provider to the subscription client", () => {
		expect(
			router({
				backboardClient: backboard(),
				subscriptionClient: byok(),
			}).sourceFor({
				provider: "openai-subscription",
				model: "gpt-subscription",
			}),
		).toBe("subscription");
	});

	it("routes the explicit Claude provider to its subscription client", () => {
		expect(
			router({
				backboardClient: backboard(),
				subscriptions: {
					"anthropic-subscription": {
						client: byok(),
						threadPrefix: "claude_sub_",
					},
				},
			}).sourceFor({
				provider: "anthropic-subscription",
				model: "sonnet",
			}),
		).toBe("subscription");
	});

	it("falls back to Backboard when no key covers the vendor", () => {
		expect(
			router({
				backboardClient: backboard(),
				byokClient: byok(),
				keyed: ["openai"],
			}).sourceFor({ provider: "anthropic", model: "claude-opus-5" }),
		).toBe("backboard");
	});

	it("falls back to Backboard for vendors with no adapter at all", () => {
		expect(
			router({
				backboardClient: backboard(),
				byokClient: byok(),
				keyed: ["cohere"],
			}).sourceFor({ provider: "cohere", model: "command-a" }),
		).toBe("backboard");
	});

	it("reports the active backend's capabilities", () => {
		const withKey = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: ["anthropic"],
		});
		expect(withKey.capabilities.assistants).toBe(false);

		const withoutKey = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: [],
		});
		expect(withoutKey.capabilities.assistants).toBe(true);
	});
});

describe("ClientRouter explicit sources (host-managed mode)", () => {
	const live = { provider: "openai", model: "gpt-5.5" };
	const anthropicModel = {
		name: "claude-opus-5",
		provider: "anthropic",
		model_type: "llm",
	};
	const openaiModel = {
		name: "gpt-5.5",
		provider: "openai",
		model_type: "llm",
	};

	it("routes the live model to the key only when the host says so", () => {
		const keyRoute = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: ["openai"],
			model: live,
			explicitSources: true,
			modelSource: "byok",
		});
		expect(keyRoute.sourceFor(live)).toBe("byok");

		// Same model, same key on hand, but no explicit route: Backboard bills.
		const backboardRoute = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: ["openai"],
			model: live,
			explicitSources: true,
			modelSource: "backboard",
		});
		expect(backboardRoute.sourceFor(live)).toBe("backboard");
	});

	it("routes every request by its own captured route, never by the live selection", async () => {
		const bb = backboard();
		const key = byok();
		// The picker moved on to another model after these requests captured
		// their route; a worker or RLM leg still naming the old model stays on
		// the key, and a Backboard-routed request stays on Backboard even while
		// the live selection is key-billed.
		const routed = router({
			backboardClient: bb,
			byokClient: key,
			keyed: ["openai"],
			model: { provider: "openai", model: "gpt-5.6" },
			explicitSources: true,
			modelSource: "byok",
		});
		await drain(
			routed.runMessage({
				content: "worker",
				llm_provider: "openai",
				model_name: "gpt-5.5",
				source: "byok",
			}),
		);
		await routed.sendMessage({
			content: "rlm leg",
			llm_provider: "openai",
			model_name: "gpt-5-mini",
			source: "byok",
		});
		await drain(
			routed.runMessage({
				content: "backboard turn",
				llm_provider: "openai",
				model_name: "gpt-5.6",
				source: "backboard",
			}),
		);
		expect({
			key: [key.messages.length, key.sent.length],
			backboard: [bb.messages.length, bb.sent.length],
		}).toEqual({ key: [1, 1], backboard: [1, 0] });
	});

	it("refuses a request that carries no billing route", () => {
		const bb = backboard();
		const key = byok();
		const routed = router({
			backboardClient: bb,
			byokClient: key,
			keyed: ["openai"],
			model: live,
			explicitSources: true,
			modelSource: "byok",
		});
		expect(() =>
			routed.runMessage({ content: "hi", llm_provider: "openai" }),
		).toThrow("without a billing route");
		expect(() =>
			routed.runToolOutputs({ thread_id: "byok_abc", tool_outputs: [] }),
		).toThrow("without a billing route");
		expect(bb.messages.length + key.messages.length).toBe(0);
	});

	it("checks a continuation's route against its thread", async () => {
		const bb = backboard();
		const key = byok();
		const routed = router({
			backboardClient: bb,
			byokClient: key,
			keyed: ["openai"],
			model: live,
			explicitSources: true,
			modelSource: "byok",
		});
		expect(() =>
			routed.runToolOutputs({
				thread_id: "byok_abc",
				tool_outputs: [],
				source: "backboard",
			}),
		).toThrow("bound to your API key");
		await drain(
			routed.runToolOutputs({
				thread_id: "byok_abc",
				tool_outputs: [],
				source: "byok",
			}),
		);
		expect([key.toolOutputs.length, bb.toolOutputs.length]).toEqual([1, 0]);
	});

	it("leaves subscription providers on their subscription route", () => {
		const routed = router({
			backboardClient: backboard(),
			subscriptionClient: byok(),
			model: { provider: "openai-subscription", model: "auto" },
			explicitSources: true,
			modelSource: "subscription",
		});
		expect(
			routed.sourceFor({ provider: "openai-subscription", model: "auto" }),
		).toBe("subscription");
	});

	it("fails a key-billed selection whose key is missing instead of falling back", async () => {
		const bb = backboard();
		const key = byok();
		const routed = router({
			backboardClient: bb,
			byokClient: key,
			keyed: [],
			model: live,
			explicitSources: true,
			modelSource: "byok",
		});
		// Routing happens while the stream is built, so the failure is synchronous.
		expect(() =>
			routed.runMessage({
				content: "hi",
				llm_provider: "openai",
				model_name: "gpt-5.5",
				source: "byok",
			}),
		).toThrow("No API key is configured for openai in this session.");
		// Naming the key-billed thread changes nothing: the key is still gone.
		expect(() =>
			routed.runMessage({
				content: "hi",
				thread_id: "byok_abc",
				llm_provider: "openai",
				model_name: "gpt-5.5",
				source: "byok",
			}),
		).toThrow("No API key is configured for openai in this session.");
		expect(bb.messages).toHaveLength(0);
		expect(key.messages).toHaveLength(0);
	});

	it("keeps Backboard and key-backed entries for the same model", async () => {
		const result = await router({
			backboardClient: backboard([anthropicModel, openaiModel]),
			byokClient: byok([openaiModel]),
			keyed: ["openai"],
			model: live,
			explicitSources: true,
			modelSource: "byok",
		}).listModels();

		expect(result.models).toEqual([
			{ ...openaiModel, source: "byok" },
			{ ...anthropicModel, source: "backboard" },
			{ ...openaiModel, source: "backboard" },
		]);
	});

	it("refuses to continue a conversation on a different billing route", async () => {
		const bb = backboard();
		const key = byok();
		const routed = router({
			backboardClient: bb,
			byokClient: key,
			keyed: ["openai"],
			model: live,
			explicitSources: true,
			modelSource: "backboard",
		});
		expect(() =>
			routed.runMessage({
				content: "hi",
				thread_id: "byok_abc",
				source: "backboard",
			}),
		).toThrow("bound to your API key");
		await drain(
			routed.runMessage({
				content: "hi",
				thread_id: "thread_bb",
				source: "backboard",
			}),
		);
		expect(bb.messages).toHaveLength(1);
		expect(key.messages).toHaveLength(0);
	});

	it("continues a key-billed conversation on its key", async () => {
		const bb = backboard();
		const key = byok();
		await drain(
			router({
				backboardClient: bb,
				byokClient: key,
				keyed: ["openai"],
				model: live,
				explicitSources: true,
				modelSource: "byok",
			}).runMessage({
				content: "hi",
				thread_id: "byok_abc",
				llm_provider: "openai",
				source: "byok",
			}),
		);
		expect(key.messages).toHaveLength(1);
		expect(bb.messages).toHaveLength(0);
	});

	it("keeps a subscription thread on its own subscription", async () => {
		const chatgpt = byok();
		const claude = byok();
		const routed = router({
			backboardClient: backboard(),
			subscriptions: {
				"openai-subscription": { client: chatgpt, threadPrefix: "sub_" },
				"anthropic-subscription": {
					client: claude,
					threadPrefix: "claude_sub_",
				},
			},
			model: { provider: "anthropic-subscription", model: "opus" },
			explicitSources: true,
			modelSource: "subscription",
		});
		const opus = { provider: "anthropic-subscription", model: "opus" };
		const gpt = { provider: "openai-subscription", model: "gpt-5.5" };
		expect([
			routed.canServeThread(opus, "claude_sub_1"),
			routed.canServeThread(gpt, "claude_sub_1"),
			routed.canServeThread(gpt, "sub_1"),
		]).toEqual([true, false, true]);
		expect(() =>
			routed.runMessage({
				thread_id: "claude_sub_1",
				content: "hi",
				llm_provider: "openai-subscription",
				model_name: "gpt-5.5",
				source: "subscription",
			}),
		).toThrow("bound to the anthropic-subscription subscription");
		expect(chatgpt.messages).toHaveLength(0);
	});

	it("routes subscription requests by their route and keeps them off other threads", async () => {
		const bb = backboard();
		const subscription = byok();
		const routed = router({
			backboardClient: bb,
			subscriptions: {
				"openai-subscription": { client: subscription, threadPrefix: "sub_" },
			},
			model: { provider: "openai-subscription", model: "auto" },
			explicitSources: true,
			modelSource: "subscription",
		});
		await drain(
			routed.runMessage({
				content: "hi",
				llm_provider: "openai-subscription",
				model_name: "auto",
				source: "subscription",
			}),
		);
		await drain(
			routed.runToolOutputs({
				thread_id: "sub_1",
				tool_outputs: [],
				source: "subscription",
			}),
		);
		expect(() =>
			routed.runToolOutputs({
				thread_id: "sub_1",
				tool_outputs: [],
				source: "backboard",
			}),
		).toThrow("bound to a subscription");
		expect({
			subscription: [
				subscription.messages.length,
				subscription.toolOutputs.length,
			],
			backboard: [bb.messages.length, bb.toolOutputs.length],
		}).toEqual({ subscription: [1, 1], backboard: [0, 0] });
	});
});

describe("ClientRouter request routing", () => {
	it("routes a new message by the selected model", async () => {
		const bb = backboard();
		const key = byok();
		await drain(
			router({
				backboardClient: bb,
				byokClient: key,
				keyed: ["anthropic"],
			}).runMessage({
				content: "hi",
				llm_provider: "anthropic",
				model_name: "claude-opus-5",
			}),
		);

		expect(key.messages).toHaveLength(1);
		expect(bb.messages).toHaveLength(0);
	});

	it("keeps a thread on its original backend even after keys change", async () => {
		const bb = backboard();
		const key = byok();
		// A Backboard thread with an anthropic key now enabled would otherwise
		// flip mid-conversation to a backend that has never seen it.
		const target = router({
			backboardClient: bb,
			byokClient: key,
			keyed: ["anthropic"],
		});

		await drain(
			target.runMessage({
				content: "hi",
				thread_id: "thread_abc",
				llm_provider: "anthropic",
				model_name: "claude-opus-5",
			}),
		);
		await drain(
			target.runToolOutputs({
				thread_id: "thread_abc",
				tool_outputs: [{ tool_call_id: "1", output: "ok" }],
			}),
		);

		expect(bb.messages).toHaveLength(1);
		expect(bb.toolOutputs).toHaveLength(1);
		expect(key.messages).toHaveLength(0);
	});

	it("routes byok_ threads to the key-backed client", async () => {
		const bb = backboard();
		const key = byok();
		await drain(
			router({
				backboardClient: bb,
				byokClient: key,
				keyed: [],
			}).runToolOutputs({
				thread_id: "byok_abc",
				tool_outputs: [{ tool_call_id: "1", output: "ok" }],
			}),
		);

		expect(key.toolOutputs).toHaveLength(1);
		expect(bb.toolOutputs).toHaveLength(0);
	});

	it("routes sub_ threads to the subscription client", async () => {
		const subscription = byok();
		await drain(
			router({ subscriptionClient: subscription }).runToolOutputs({
				thread_id: "sub_abc",
				tool_outputs: [{ tool_call_id: "1", output: "ok" }],
			}),
		);

		expect(subscription.toolOutputs).toHaveLength(1);
	});

	it("routes claude_sub_ threads to the Claude subscription client", async () => {
		const claude = byok();
		await drain(
			router({
				subscriptions: {
					"anthropic-subscription": {
						client: claude,
						threadPrefix: "claude_sub_",
					},
				},
			}).runToolOutputs({
				thread_id: "claude_sub_abc",
				tool_outputs: [{ tool_call_id: "1", output: "ok" }],
			}),
		);

		expect(claude.toolOutputs).toHaveLength(1);
	});
});

describe("ClientRouter catalog", () => {
	const anthropicModel = {
		name: "claude-opus-5",
		provider: "anthropic",
		model_type: "llm",
	};
	const openaiModel = {
		name: "gpt-5.5",
		provider: "openai",
		model_type: "llm",
	};

	it("merges both catalogs and tags each entry with its source", async () => {
		const result = await router({
			backboardClient: backboard([openaiModel]),
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toEqual([
			{ ...anthropicModel, source: "byok" },
			{ ...openaiModel, source: "backboard" },
		]);
	});

	it("merges multiple subscription catalogs", async () => {
		const chatGptModel = {
			name: "auto",
			provider: "openai-subscription",
			model_type: "llm",
		};
		const claudeModel = {
			name: "sonnet",
			provider: "anthropic-subscription",
			model_type: "llm",
		};
		const result = await router({
			subscriptions: {
				"openai-subscription": {
					client: byok([chatGptModel]),
					threadPrefix: "sub_",
				},
				"anthropic-subscription": {
					client: byok([claudeModel]),
					threadPrefix: "claude_sub_",
				},
			},
		}).listModels();

		expect(result.models).toEqual([
			{ ...chatGptModel, source: "subscription" },
			{ ...claudeModel, source: "subscription" },
		]);
	});

	it("lets the key-backed entry win a duplicate", async () => {
		const result = await router({
			backboardClient: backboard([anthropicModel, openaiModel]),
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toHaveLength(2);
		expect(
			result.models.find((model) => model.name === "claude-opus-5")?.source,
		).toBe("byok");
	});

	it("shows only key-backed models when there is no sign-in", async () => {
		const result = await router({
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toEqual([{ ...anthropicModel, source: "byok" }]);
	});

	it("keeps the available catalog when one backend fails", async () => {
		class FailingModelClient extends RecordingClient {
			override async listModels(): Promise<ModelsListResponse> {
				throw new Error("catalog unavailable");
			}
		}
		const result = await router({
			backboardClient: new FailingModelClient("backboard", {
				assistants: true,
				threads: true,
				memory: true,
			}),
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toEqual([{ ...anthropicModel, source: "byok" }]);
	});

	it("fails only when every available catalog fails", async () => {
		class FailingModelClient extends RecordingClient {
			override async listModels(): Promise<ModelsListResponse> {
				throw new Error(`${this.name} unavailable`);
			}
		}
		await expect(
			router({
				backboardClient: new FailingModelClient("backboard", {
					assistants: true,
					threads: true,
					memory: true,
				}),
				byokClient: new FailingModelClient("byok", {
					assistants: false,
					threads: false,
					memory: false,
				}),
				keyed: ["anthropic"],
			}).listModels(),
		).rejects.toThrow("Failed to list models from every available backend");
	});
});

describe("ClientRouter.sendMessage routing", () => {
	// RLM legs carry their own model and thread through sendMessage. Routing on
	// the live `/model` selection instead sent them to the wrong backend.
	it("routes by the request's model, not the picker selection", async () => {
		const backboardClient = backboard();
		const byokClient = byok();
		await router({
			backboardClient,
			byokClient,
			model: { provider: "anthropic", model: "claude-opus-5" },
			keyed: ["anthropic"],
		}).sendMessage({
			content: "hi",
			llm_provider: "openai",
			model_name: "gpt-5.1",
		});

		// The picker is on a keyed vendor, but the request names an unkeyed one.
		expect(byokClient.sent).toHaveLength(0);
		expect(backboardClient.sent).toHaveLength(1);
	});

	it("routes by the thread's origin when the request names one", async () => {
		const backboardClient = backboard();
		const byokClient = byok();
		await router({
			backboardClient,
			byokClient,
			keyed: ["anthropic"],
		}).sendMessage({ content: "hi", thread_id: "thread_backboard" });

		expect(byokClient.sent).toHaveLength(0);
		expect(backboardClient.sent).toHaveLength(1);
	});
});

describe("ClientRouter sign-in state", () => {
	// The Backboard client is constructed unconditionally so a mid-session
	// /login works without a restart; routing has to gate on live auth instead.
	it("ignores the Backboard client while no sign-in is active", () => {
		const routed = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: [],
			signedIn: false,
		});

		expect(routed.sourceFor({ provider: "anthropic", model: "x" })).toBe(
			"byok",
		);
	});

	it("routes to Backboard once a sign-in lands", () => {
		const routed = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: [],
			signedIn: true,
		});

		expect(routed.sourceFor({ provider: "anthropic", model: "x" })).toBe(
			"backboard",
		);
	});
});

describe("ClientRouter sessions", () => {
	const localThread: BackboardThread = {
		thread_id: "byok_local",
		messages: [],
	};
	const remoteThread: BackboardThread = {
		thread_id: "thread_remote",
		messages: [],
	};

	it("merges local BYOK and Backboard sessions", async () => {
		const local = new RecordingClient(
			"byok",
			{ assistants: false, threads: true, memory: false },
			[],
			[localThread],
		);
		const remote = new RecordingClient(
			"backboard",
			{ assistants: true, threads: true, memory: true },
			[],
			[remoteThread],
		);

		expect(
			await router({
				backboardClient: remote,
				byokClient: local,
				keyed: ["anthropic"],
			}).listThreads(),
		).toEqual([localThread, remoteThread]);
	});

	it("keeps successful Backboard sessions when the local store fails", async () => {
		class FailingListClient extends RecordingClient {
			override async listThreads(): Promise<BackboardThread[]> {
				throw new Error("local sessions unreadable");
			}
		}
		const local = new FailingListClient("byok", {
			assistants: false,
			threads: true,
			memory: false,
		});
		const remote = new RecordingClient(
			"backboard",
			{ assistants: true, threads: true, memory: true },
			[],
			[remoteThread],
		);

		expect(
			await router({
				backboardClient: remote,
				byokClient: local,
				keyed: ["anthropic"],
			}).listThreads(),
		).toEqual([remoteThread]);
	});

	it("loads a session from the backend that owns its thread id", async () => {
		const local = new RecordingClient(
			"byok",
			{ assistants: false, threads: true, memory: false },
			[],
			[localThread],
		);
		const remote = new RecordingClient(
			"backboard",
			{ assistants: true, threads: true, memory: true },
			[],
			[remoteThread],
		);
		const target = router({
			backboardClient: remote,
			byokClient: local,
			keyed: ["anthropic"],
		});

		expect(await target.getThread("byok_local")).toBe(localThread);
		expect(await target.getThread("thread_remote")).toBe(remoteThread);
	});
});

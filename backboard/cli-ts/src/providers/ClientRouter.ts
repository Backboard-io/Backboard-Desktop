import type { ModelRef } from "../config/defaults.ts";
import { formatModel } from "../config/defaults.ts";
import type { OpenAITool } from "../core/tools/schema.ts";
import type {
	AgentClient,
	AgentClientCapabilities,
	RequestOptions,
	RunMessageOptions,
} from "./AgentClient.ts";
import type {
	AssistantInfo,
	BackboardResponse,
	BackboardThread,
	GenerateVideoRequest,
	GenerateVideoResult,
	ImageModelsListResponse,
	ModelCatalogItem,
	ModelSource,
	ModelsListResponse,
	ModelThinkingMetadataResponse,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
	SystemOneRequest,
	SystemOneResult,
	VideoModelsListResponse,
} from "./backboard/types.ts";
import { byokAdapterFor } from "./byok/registry.ts";

export type ClientSource = ModelSource;

export const CHATGPT_SUBSCRIPTION_PROVIDER = "openai-subscription";
export const CLAUDE_SUBSCRIPTION_PROVIDER = "anthropic-subscription";
export const CHATGPT_SUBSCRIPTION_THREAD_PREFIX = "sub_";
export const CLAUDE_SUBSCRIPTION_THREAD_PREFIX = "claude_sub_";

export interface SubscriptionClientRoute {
	client: AgentClient;
	threadPrefix: string;
}

export interface ClientRouterDeps {
	backboard?: AgentClient;
	byok?: AgentClient;
	/** @deprecated Use `subscriptions.openai-subscription` for new call sites. */
	subscription?: AgentClient;
	/** Subscription clients keyed by their explicit model provider id. */
	subscriptions?: Readonly<Record<string, SubscriptionClientRoute>>;
	/** The live `/model` selection, used to route requests that carry no thread. */
	getModel: () => ModelRef;
	/**
	 * True when a Backboard sign-in is currently active. Checked per request
	 * rather than at construction, so `/login` and `/logout` take effect on the
	 * next turn. Omit to treat a supplied `backboard` client as always usable.
	 */
	hasBackboardAuth?: () => boolean;
	/** True when an enabled saved key can serve this provider. */
	hasKeyFor: (provider: string) => boolean;
	/**
	 * Host-managed mode: a key never wins implicitly. Every request states its
	 * own billing route (`source`), captured when its turn or worker started,
	 * and a request without one is refused. The TUI leaves this off.
	 */
	explicitSources?: boolean;
	/** The billing route the host attached to the live model, when explicit. */
	getModelSource?: () => ModelSource | undefined;
}

/**
 * Routes each request to the backend that can serve it.
 *
 * The precedence rule is the product one: a saved provider key always wins over
 * a Backboard sign-in for the same vendor, so adding a key silently moves those
 * models onto the user's own billing. Requests that name an existing thread
 * route by that thread's origin instead, so toggling a key mid-conversation
 * can never split one thread across two backends.
 *
 * In explicit mode (`explicitSources`) the precedence rule is off: every
 * request carries the route its turn captured and nothing is inferred from the
 * live selection or from which keys happen to be held, so neither a key change
 * nor a model change can move a running turn's billing.
 */
export class ClientRouter implements AgentClient {
	constructor(private readonly deps: ClientRouterDeps) {}

	/** Which backend owns a given model, honouring key-over-SSO precedence. */
	sourceFor(model: ModelRef = this.deps.getModel()): ClientSource {
		if (
			isSubscriptionProvider(model.provider) ||
			this.subscriptionForProvider(model.provider)
		) {
			return "subscription";
		}
		if (this.deps.explicitSources) {
			// Only the live selection has a host-stated route; it answers for
			// capability and catalog questions. Requests never come through here.
			return this.deps.getModelSource?.() === "byok" ? "byok" : "backboard";
		}
		if (
			this.deps.byok &&
			byokAdapterFor(model.provider) &&
			this.deps.hasKeyFor(model.provider)
		) {
			return "byok";
		}
		return this.backboard() ? "backboard" : "byok";
	}

	/** The Backboard client, or undefined while no sign-in is active. */
	private backboard(): AgentClient | undefined {
		if (!this.deps.backboard) return undefined;
		if (this.deps.hasBackboardAuth && !this.deps.hasBackboardAuth()) {
			return undefined;
		}
		return this.deps.backboard;
	}

	get capabilities(): AgentClientCapabilities {
		return this.active().capabilities;
	}

	runMessage(
		req: SendMessageRequest,
		options?: RunMessageOptions,
	): AsyncIterable<ProviderEvent> {
		return this.forRequest(req).runMessage(req, options);
	}

	runToolOutputs(
		req: SubmitToolOutputsRequest,
		options?: RequestOptions,
	): AsyncIterable<ProviderEvent> {
		return this.forContinuation(req).runToolOutputs(req, options);
	}

	preserveFailedMessage(
		req: SendMessageRequest,
		options?: RunMessageOptions,
	): Promise<string | null> {
		return (
			this.forRequest(req).preserveFailedMessage?.(req, options) ??
			Promise.resolve(null)
		);
	}

	preserveFailedToolOutputs(
		req: SubmitToolOutputsRequest,
		options?: RequestOptions,
	): Promise<string | null> {
		return (
			this.forContinuation(req).preserveFailedToolOutputs?.(req, options) ??
			Promise.resolve(null)
		);
	}

	canServeThread(model: ModelRef, threadId: string): boolean {
		if (this.sourceFor(model) !== this.sourceForThread(threadId)) return false;
		const threadRoute = this.subscriptionForThread(threadId);
		const modelRoute = this.subscriptionForProvider(model.provider);
		return (
			!threadRoute ||
			!modelRoute ||
			threadRoute.provider === modelRoute.provider
		);
	}

	sourceForThread(threadId: string): ClientSource {
		if (
			this.subscriptionForThread(threadId) ||
			knownSubscriptionForThread(threadId)
		) {
			return "subscription";
		}
		return threadId.startsWith("byok_") ? "byok" : "backboard";
	}

	sendMessage(
		req: SendMessageRequest,
		options?: RequestOptions,
	): Promise<BackboardResponse> {
		return this.forRequest(req).sendMessage(req, options);
	}

	getModelThinkingMetadata(
		provider: string,
		model: string,
		options?: RequestOptions,
	): Promise<ModelThinkingMetadataResponse> {
		return (
			options?.source
				? this.forRoute(options.source, undefined, { provider, model })
				: this.clientFor({ provider, model })
		).getModelThinkingMetadata(provider, model, options);
	}

	/**
	 * The merged catalog. Signed in, the user sees everything; with keys only,
	 * they see exactly what their keys can reach. Where both offer the same
	 * `provider/model`, the key-backed entry replaces the routed one - matching
	 * where the request would actually go. In explicit mode both entries are
	 * kept, because the host presents them as two distinct billing routes.
	 */
	async listModels(options?: RequestOptions): Promise<ModelsListResponse> {
		const backboardClient = this.backboard();
		const clients: Array<{ source: ClientSource; client: AgentClient }> = [
			...(this.deps.byok
				? [{ source: "byok", client: this.deps.byok } as const]
				: []),
			...this.subscriptionRoutes().map(({ client }) => ({
				source: "subscription" as const,
				client,
			})),
			...(backboardClient
				? [{ source: "backboard", client: backboardClient } as const]
				: []),
		];
		if (clients.length === 0) return { models: [], total: 0 };
		const results = await Promise.allSettled(
			clients.map(({ client }) => client.listModels(options)),
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failures.length === results.length) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"Failed to list models from every available backend.",
			);
		}
		const models: ModelCatalogItem[] = [];
		const seen = new Set<string>();
		for (let index = 0; index < results.length; index++) {
			const result = results[index];
			const source = clients[index]?.source;
			if (result?.status !== "fulfilled" || !source) continue;
			for (const model of result.value.models) {
				const key = this.deps.explicitSources
					? `${source}:${modelKey(model)}`
					: modelKey(model);
				if (seen.has(key)) continue;
				seen.add(key);
				models.push({ ...model, source });
			}
		}
		return { models, total: models.length };
	}

	listAssistants(
		options?: RequestOptions,
		filter?: { name?: string },
	): Promise<AssistantInfo[]> {
		return this.active().listAssistants(options, filter);
	}

	/**
	 * Image/video generation catalogs live only on the Backboard backend,
	 * so these forward there rather than merging across clients.
	 */
	async listImageModels(
		options?: RequestOptions,
	): Promise<ImageModelsListResponse> {
		const backboard = this.backboard();
		if (!backboard?.listImageModels) return { models: [], total: 0 };
		return backboard.listImageModels(options);
	}

	async listVideoModels(
		options?: RequestOptions,
	): Promise<VideoModelsListResponse> {
		const backboard = this.backboard();
		if (!backboard?.listVideoModels) return { models: [], total: 0 };
		return backboard.listVideoModels(options);
	}

	async generateVideo(
		request: GenerateVideoRequest,
		options?: RequestOptions,
	): Promise<GenerateVideoResult> {
		const backboard = this.backboard();
		if (!backboard?.generateVideo) {
			throw new Error(
				"Video generation requires a signed-in Backboard account.",
			);
		}
		return backboard.generateVideo(request, options);
	}

	async systemOne(
		request: SystemOneRequest,
		options?: RequestOptions,
	): Promise<SystemOneResult> {
		const backboard = this.backboard();
		if (!backboard?.systemOne) {
			throw new Error(
				"Jev computer use requires a signed-in Backboard account.",
			);
		}
		return backboard.systemOne(request, options);
	}

	createAssistant(
		req: { name: string; system_prompt: string; tools: OpenAITool[] },
		options?: RequestOptions,
	): Promise<AssistantInfo> {
		return this.active().createAssistant(req, options);
	}

	async listThreads(options?: RequestOptions): Promise<BackboardThread[]> {
		const clients = uniqueClients([
			this.deps.byok,
			...this.subscriptionRoutes().map(({ client }) => client),
			this.backboard(),
		]);
		if (clients.length === 0) return [];
		const results = await Promise.allSettled(
			clients.map((client) => client.listThreads(options)),
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failures.length === results.length) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"Failed to list sessions from every available backend.",
			);
		}
		const threads = results.flatMap((result) =>
			result.status === "fulfilled" ? result.value : [],
		);
		const seen = new Set<string>();
		return threads.filter((thread) => {
			if (seen.has(thread.thread_id)) return false;
			seen.add(thread.thread_id);
			return true;
		});
	}

	getThread(
		threadId: string,
		options?: RequestOptions,
	): Promise<BackboardThread> {
		return this.forThread(threadId).getThread(threadId, options);
	}

	/**
	 * Where a request belongs: its thread's backend if it names one, otherwise
	 * the backend for the model it asks for.
	 *
	 * Both entry points route this way. `sendMessage` used to fall back to the
	 * live `/model` selection and ignore the request entirely, which sent RLM
	 * legs - they carry their own model and thread - to whichever backend the
	 * picker happened to be on.
	 */
	private forRequest(req: SendMessageRequest): AgentClient {
		const live = this.deps.getModel();
		const model = {
			provider: req.llm_provider ?? live.provider,
			model: req.model_name ?? live.model,
		};
		if (this.deps.explicitSources) {
			return this.forRoute(req.source, req.thread_id, model);
		}
		if (req.thread_id) return this.forThread(req.thread_id);
		return this.clientFor(model);
	}

	/** A continuation belongs to its thread; explicit mode still checks the route. */
	private forContinuation(req: SubmitToolOutputsRequest): AgentClient {
		if (this.deps.explicitSources) {
			return this.forRoute(req.source, req.thread_id);
		}
		return this.forThread(req.thread_id);
	}

	/**
	 * Explicit mode: the request's own route decides, and nothing is inferred
	 * from the live selection, the thread, or which keys are held. A request
	 * without a route is a runtime bug and is refused; a key-billed request
	 * whose key is gone fails rather than falling back to Backboard; a thread
	 * created on another backend is refused, because the IDE hands off to a
	 * fresh thread on a route change and failing loudly beats billing the wrong
	 * account. `model` is the request's own model when it names one; a
	 * continuation names none and is served by its thread's backend.
	 */
	private forRoute(
		source: ModelSource | undefined,
		threadId: string | undefined,
		model?: ModelRef,
	): AgentClient {
		if (source === undefined) {
			throw new Error(
				"Refusing to send a request without a billing route in host-managed mode.",
			);
		}
		if (threadId) this.assertThreadMatchesSource(threadId, source);
		const described = model ? formatModel(model) : "this conversation";
		if (source === "subscription") {
			const threadRoute = threadId
				? this.subscriptionForThread(threadId)
				: undefined;
			const modelRoute = model
				? this.subscriptionForProvider(model.provider)
				: undefined;
			// A subscription thread lives in that subscription's own store; the
			// other subscription can only answer "Unknown conversation".
			if (
				threadRoute &&
				modelRoute &&
				threadRoute.provider !== modelRoute.provider
			) {
				throw new Error(
					`This conversation is bound to the ${threadRoute.provider} subscription, but this request bills to the ${modelRoute.provider} subscription. Start a new conversation to switch.`,
				);
			}
			const route = modelRoute || threadRoute;
			if (!route) {
				throw new Error(
					`No connected subscription can serve ${described}. Connect the subscription and start a new conversation.`,
				);
			}
			return route.client;
		}
		if (source === "byok") {
			if (model && !this.deps.hasKeyFor(model.provider)) {
				throw new Error(
					`No API key is configured for ${model.provider} in this session.`,
				);
			}
			if (!this.deps.byok) {
				throw new Error(`No API key backend can serve ${described}.`);
			}
			return this.deps.byok;
		}
		const backboard = this.backboard();
		if (!backboard) {
			throw new Error(
				`No backend can serve ${described}. Sign in with Backboard to continue.`,
			);
		}
		return backboard;
	}

	private assertThreadMatchesSource(
		threadId: string,
		source: ModelSource,
	): void {
		const threadSource = this.sourceForThread(threadId);
		if (threadSource === source) return;
		throw new Error(
			`This conversation is bound to ${describeSource(threadSource)}, but this request bills to ${describeSource(source)}. Start a new conversation to switch.`,
		);
	}

	private active(): AgentClient {
		return this.clientFor(this.deps.getModel());
	}

	private clientFor(model: ModelRef): AgentClient {
		const source = this.sourceFor(model);
		if (
			source === "byok" &&
			this.deps.explicitSources &&
			!this.deps.hasKeyFor(model.provider)
		) {
			throw new Error(
				`No API key is configured for ${model.provider} in this session.`,
			);
		}
		const client =
			source === "byok"
				? this.deps.byok
				: source === "subscription"
					? this.subscriptionForProvider(model.provider)?.client
					: this.backboard();
		if (!client) {
			throw new Error(
				`No backend can serve ${formatModel(model)}. Sign in with Backboard, connect the required subscription, or add a key with /keys.`,
			);
		}
		return client;
	}

	/** Local clients mint distinct prefixes; Backboard ids never collide. */
	private forThread(threadId: string): AgentClient {
		const subscription = this.subscriptionForThread(threadId);
		if (subscription) return subscription.client;
		const knownSubscription = knownSubscriptionForThread(threadId);
		if (knownSubscription) {
			throw new Error(
				`This thread requires a connected ${knownSubscription.label} subscription.`,
			);
		}
		if (threadId.startsWith("byok_") && this.deps.byok) return this.deps.byok;
		const backboard = this.backboard();
		if (!threadId.startsWith("byok_") && backboard) return backboard;
		return this.active();
	}

	private subscriptionForProvider(
		provider: string,
	): (SubscriptionClientRoute & { provider: string }) | undefined {
		const normalized = normalizeProvider(provider);
		return this.subscriptionRoutes().find(
			(route) => route.provider === normalized,
		);
	}

	private subscriptionForThread(
		threadId: string,
	): (SubscriptionClientRoute & { provider: string }) | undefined {
		return this.subscriptionRoutes()
			.sort(
				(left, right) => right.threadPrefix.length - left.threadPrefix.length,
			)
			.find((route) => threadId.startsWith(route.threadPrefix));
	}

	private subscriptionRoutes(): Array<
		SubscriptionClientRoute & { provider: string }
	> {
		const routes = new Map<
			string,
			SubscriptionClientRoute & { provider: string }
		>();
		if (this.deps.subscription) {
			routes.set(CHATGPT_SUBSCRIPTION_PROVIDER, {
				provider: CHATGPT_SUBSCRIPTION_PROVIDER,
				client: this.deps.subscription,
				threadPrefix: CHATGPT_SUBSCRIPTION_THREAD_PREFIX,
			});
		}
		for (const [provider, route] of Object.entries(
			this.deps.subscriptions ?? {},
		)) {
			const normalized = normalizeProvider(provider);
			if (!normalized || !route.threadPrefix) continue;
			routes.set(normalized, { provider: normalized, ...route });
		}
		return [...routes.values()];
	}
}

const KNOWN_SUBSCRIPTIONS = [
	{
		provider: CHATGPT_SUBSCRIPTION_PROVIDER,
		threadPrefix: CHATGPT_SUBSCRIPTION_THREAD_PREFIX,
		label: "ChatGPT",
	},
	{
		provider: CLAUDE_SUBSCRIPTION_PROVIDER,
		threadPrefix: CLAUDE_SUBSCRIPTION_THREAD_PREFIX,
		label: "Claude",
	},
] as const;

function isSubscriptionProvider(provider: string): boolean {
	const normalized = normalizeProvider(provider);
	return KNOWN_SUBSCRIPTIONS.some(
		(subscription) => subscription.provider === normalized,
	);
}

function knownSubscriptionForThread(threadId: string) {
	return KNOWN_SUBSCRIPTIONS.find((subscription) =>
		threadId.startsWith(subscription.threadPrefix),
	);
}

function normalizeProvider(provider: string): string {
	return provider.trim().toLowerCase();
}

function describeSource(source: ClientSource): string {
	switch (source) {
		case "byok":
			return "your API key";
		case "subscription":
			return "a subscription";
		default:
			return "Backboard";
	}
}

function uniqueClients(clients: Array<AgentClient | undefined>): AgentClient[] {
	return [
		...new Set(clients.filter((client): client is AgentClient => !!client)),
	];
}

function modelKey(model: ModelCatalogItem): string {
	return `${model.provider.trim().toLowerCase()}/${model.name.trim().toLowerCase()}`;
}

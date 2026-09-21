import { basename } from "node:path";
import type { BackboardEnv } from "../../config/env.ts";
import type { ServerEventLog } from "../../core/session/ServerEventLog.ts";
import type { OpenAITool } from "../../core/tools/schema.ts";
import { errorMessage } from "../../utils/errors.ts";
import type {
	AgentClient,
	AgentClientCapabilities,
	RequestOptions,
	RunMessageOptions,
} from "../AgentClient.ts";
import {
	MODEL_PAGE_LIMIT,
	SYSTEM_ONE_DEFAULT_MODEL,
	SYSTEM_ONE_PROVIDER,
} from "./constants.ts";
import { BackboardError, BackboardTransportError } from "./errors.ts";
import {
	BackboardStreamEventMapper,
	type ToolMappingTrace,
} from "./mappers.ts";
import { isSelectableProvider } from "./modelCatalog.ts";
import { parseSseFrame, readSseFrames } from "./sse.ts";
import {
	isRetryableStreamServerError,
	streamRetryDelayMs,
	streamServerErrorRetries,
} from "./streamRetry.ts";
import type {
	AssistantInfo,
	BackboardResponse,
	BackboardThread,
	GeneratedMediaInfo,
	GenerateVideoRequest,
	GenerateVideoResult,
	ImageModelsListResponse,
	ModelCatalogItem,
	ModelsListResponse,
	ModelThinkingMetadataResponse,
	OpenRouterModelProvidersResponse,
	ProviderEvent,
	ProvidersListResponse,
	SendMessageRequest,
	SubmitToolOutputsRequest,
	SystemOneRequest,
	SystemOneResult,
	VideoModelsListResponse,
} from "./types.ts";

export type {
	RequestOptions,
	RunMessageOptions,
} from "../AgentClient.ts";

/**
 * The billing route is a local routing hint for the ClientRouter; the API has
 * no such field and must never see it.
 */
function wireRequest<T extends Pick<SendMessageRequest, "source">>(
	req: T,
): Omit<T, "source"> {
	const { source: _source, ...wire } = req;
	return wire;
}

/** JSON-encodes the object-valued request fields the form path expects as strings. */
function messageFormData(
	req: SendMessageRequest & { stream: boolean },
	filePaths: string[],
): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(req)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "object") {
			form.append(key, JSON.stringify(value));
		} else {
			form.append(key, String(value));
		}
	}
	for (const filePath of filePaths) {
		form.append("files", Bun.file(filePath), basename(filePath));
	}
	return form;
}

/**
 * Backboard transport. JSON helpers keep the simple request/response endpoints
 * available; the run generators consume Backboard's SSE turn streams.
 */
export class BackboardClient implements AgentClient {
	/** Backboard holds threads, assistants, and memory server-side. */
	readonly capabilities: AgentClientCapabilities = {
		assistants: true,
		threads: true,
		memory: true,
	};
	private readonly modelThinkingMetadataCache = new Map<
		string,
		ModelThinkingMetadataResponse
	>();

	constructor(
		private readonly env: BackboardEnv,
		private readonly serverLog?: ServerEventLog,
	) {}

	private headers(): Record<string, string> {
		return {
			"X-API-Key": this.env.apiKey,
			"Content-Type": "application/json",
		};
	}

	private post<T>(
		path: string,
		body: unknown,
		options: RequestOptions,
	): Promise<T> {
		return this.withTransientRetry(options.signal, () =>
			this.postOnce<T>(path, body, options),
		);
	}

	private async postOnce<T>(
		path: string,
		body: unknown,
		options: RequestOptions,
	): Promise<T> {
		const url = `${this.env.apiUrl}${path}`;
		const headers = this.headers();
		const started = Date.now();

		this.serverLog?.request({ endpoint: path, method: "POST", headers, body });

		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options.signal,
			});
		} catch (err) {
			this.serverLog?.response({
				endpoint: path,
				method: "POST",
				status: 0,
				body: null,
				latencyMs: Date.now() - started,
				error: errorMessage(err),
			});
			throw err;
		}

		const text = await res.text();
		const parsed = safeJson(text);

		this.serverLog?.response({
			endpoint: path,
			method: "POST",
			status: res.status,
			body: parsed,
			latencyMs: Date.now() - started,
			...(res.ok ? {} : { error: `HTTP ${res.status}` }),
		});

		if (!res.ok) {
			throw new BackboardError(
				`Backboard request failed: HTTP ${res.status}`,
				res.status,
				parsed,
			);
		}

		return parsed as T;
	}

	private get<T>(path: string, options: RequestOptions): Promise<T> {
		return this.withTransientRetry(options.signal, () =>
			this.getOnce<T>(path, options),
		);
	}

	private async getOnce<T>(path: string, options: RequestOptions): Promise<T> {
		const url = `${this.env.apiUrl}${path}`;
		const headers = this.headers();
		const started = Date.now();
		this.serverLog?.request({
			endpoint: path,
			method: "GET",
			headers,
			body: null,
		});

		const res = await fetch(url, {
			method: "GET",
			headers,
			signal: options.signal,
		});
		const text = await res.text();
		const parsed = safeJson(text);

		this.serverLog?.response({
			endpoint: path,
			method: "GET",
			status: res.status,
			body: parsed,
			latencyMs: Date.now() - started,
			...(res.ok ? {} : { error: `HTTP ${res.status}` }),
		});

		if (!res.ok) {
			throw new BackboardError(
				`Backboard request failed: HTTP ${res.status}`,
				res.status,
				parsed,
			);
		}

		return parsed as T;
	}

	/**
	 * Replays request/response calls through the same transient-failure policy
	 * the stream consumer applies: retryable statuses (502/503/504) and
	 * matching transport errors back off and resend; aborts and everything
	 * else throw immediately. Non-stream calls have no consumer above them,
	 * so without this a single gateway blip fails the whole turn.
	 */
	private async withTransientRetry<T>(
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		const maxAttempts = 1 + streamServerErrorRetries();
		for (let attempt = 1; ; attempt++) {
			try {
				return await run();
			} catch (err) {
				if (
					attempt >= maxAttempts ||
					isAbortError(err) ||
					signal?.aborted ||
					!isRetryableStreamServerError(err)
				) {
					throw err;
				}
				await sleepBeforeRetry(streamRetryDelayMs(attempt), signal);
			}
		}
	}

	async sendMessage(
		req: SendMessageRequest,
		options: RequestOptions = {},
	): Promise<BackboardResponse> {
		return this.post<BackboardResponse>(
			"/threads/messages",
			wireRequest(req),
			options,
		);
	}

	async generateVideo(
		request: GenerateVideoRequest,
		options: RequestOptions = {},
	): Promise<GenerateVideoResult> {
		const response = await this.post<BackboardResponse>(
			"/threads/messages",
			{
				operation: "generate_video",
				content: request.prompt,
				video_model_provider: request.video_model_provider,
				video_model_name: request.video_model_name,
				...(request.video_config ? { video_config: request.video_config } : {}),
				stream: false,
			},
			options,
		);
		const media = generatedVideoFromResponse(response);
		if (!media) {
			throw new Error("Backboard did not return a generated video.");
		}
		return media;
	}

	/**
	 * Asks a System One decision model (TypeSafe Jev) a bounded set of
	 * questions. Text in, probabilities out: no generation controls, tools, or
	 * attachments apply, and the request is never streamed.
	 */
	async systemOne(
		request: SystemOneRequest,
		options: RequestOptions = {},
	): Promise<SystemOneResult> {
		const response = await this.post<
			BackboardResponse & {
				system_one?: { model?: string; answers?: SystemOneResult["answers"] };
			}
		>(
			"/threads/messages",
			{
				llm_provider: SYSTEM_ONE_PROVIDER,
				model_name: request.model_name ?? SYSTEM_ONE_DEFAULT_MODEL,
				stream: false,
				...(request.thread_id ? { thread_id: request.thread_id } : {}),
				system_one: { state: request.state, questions: request.questions },
			},
			options,
		);
		const answers = response.system_one?.answers;
		if (!answers) {
			throw new Error("Backboard did not return System One answers.");
		}
		return {
			thread_id: response.thread_id,
			model: response.system_one?.model ?? SYSTEM_ONE_DEFAULT_MODEL,
			answers,
		};
	}

	async *runMessage(
		req: SendMessageRequest,
		options: RunMessageOptions = {},
	): AsyncIterable<ProviderEvent> {
		const wire = wireRequest(req);
		const body = options.attachmentFilePaths?.length
			? messageFormData({ ...wire, stream: true }, options.attachmentFilePaths)
			: { ...wire, stream: true };
		yield* this.postStream(
			"/threads/messages",
			body,
			options,
			req.tools?.map((tool) => tool.function.name),
		);
	}

	async *runToolOutputs(
		req: SubmitToolOutputsRequest,
		options: RequestOptions = {},
	): AsyncIterable<ProviderEvent> {
		const wire = wireRequest(req);
		if (wire.run_id) {
			const { run_id: runId, thread_id: threadId, ...body } = wire;
			yield* this.postStream(
				`/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/submit-tool-outputs?stream=true`,
				{ ...body, stream: true },
				options,
				req.tools?.map((tool) => tool.function.name),
			);
			return;
		}
		yield* this.postStream(
			"/threads/tool-outputs",
			{ ...wire, stream: true },
			options,
			req.tools?.map((tool) => tool.function.name),
		);
	}

	async listModels(options: RequestOptions = {}): Promise<ModelsListResponse> {
		const [providers, openRouterRoutes] = await Promise.all([
			this.listModelProviders(options),
			this.listOpenRouterModelProviders(options).catch(() => undefined),
		]);
		const pages = await Promise.all(
			providers.map((provider) =>
				this.listModelPages(
					`/models/provider/${encodeURIComponent(provider)}`,
					{},
					options,
				),
			),
		);
		const routesByModel = new Map<
			string,
			OpenRouterModelProvidersResponse["data"]
		>();
		for (const route of openRouterRoutes?.data ?? []) {
			const routes = routesByModel.get(route.model) ?? [];
			routes.push(route);
			routesByModel.set(route.model, routes);
		}
		const models = pages
			.flatMap((page) => page.models)
			.map((model) => {
				if (model.provider.toLowerCase() !== "openrouter") return model;
				const modelId = model.name
					.replace(/^~/, "")
					.replace(/^openrouter\//, "");
				const openrouterProviders = routesByModel.get(modelId);
				return openrouterProviders?.length
					? { ...model, openrouter_providers: openrouterProviders }
					: model;
			});
		return {
			models,
			total: pages.reduce((sum, page) => sum + page.total, 0),
		};
	}

	/** Lists the real upstreams OpenRouter can use, independently of model publisher namespaces. */
	async listOpenRouterModelProviders(
		options: RequestOptions = {},
		model?: string,
	): Promise<OpenRouterModelProvidersResponse> {
		const query = model ? `?model=${encodeURIComponent(model)}` : "";
		return this.get<OpenRouterModelProvidersResponse>(
			`/billing/models/providers${query}`,
			options,
		);
	}

	/** Live image-generation catalog (`GET /models/image/all`). */
	async listImageModels(
		options: RequestOptions = {},
	): Promise<ImageModelsListResponse> {
		return this.get<ImageModelsListResponse>(
			"/models/image/all?limit=500",
			options,
		);
	}

	/** Live video-generation catalog (`GET /models/video/all`). */
	async listVideoModels(
		options: RequestOptions = {},
	): Promise<VideoModelsListResponse> {
		return this.get<VideoModelsListResponse>(
			"/models/video/all?limit=1000",
			options,
		);
	}

	async getModelThinkingMetadata(
		provider: string,
		model: string,
		options: RequestOptions = {},
	): Promise<ModelThinkingMetadataResponse> {
		const cacheKey = `${provider}\u0000${model}`;
		const cached = this.modelThinkingMetadataCache.get(cacheKey);
		if (cached) return cached;
		const query = new URLSearchParams({ provider, model });
		const metadata = await this.get<ModelThinkingMetadataResponse>(
			`/models/thinking-metadata?${query}`,
			options,
		);
		this.modelThinkingMetadataCache.set(cacheKey, metadata);
		return metadata;
	}

	async listAssistants(
		options: RequestOptions = {},
		filter: { name?: string } = {},
	): Promise<AssistantInfo[]> {
		const query = new URLSearchParams({ limit: "200" });
		// Exact-name filter keeps the response to one small record instead of
		// every assistant's full system prompt (~5MB at limit=200). Older
		// servers ignore the param and return the full list, which callers
		// still .find() over, so this stays backward compatible.
		if (filter.name) query.set("name", filter.name);
		return this.get<AssistantInfo[]>(`/assistants?${query}`, options);
	}

	async listThreads(options: RequestOptions = {}): Promise<BackboardThread[]> {
		return this.get<BackboardThread[]>(
			"/threads?limit=200&include_messages=false",
			options,
		);
	}

	async getThread(
		threadId: string,
		options: RequestOptions = {},
	): Promise<BackboardThread> {
		return this.get<BackboardThread>(
			`/threads/${encodeURIComponent(threadId)}`,
			options,
		);
	}

	async createAssistant(
		req: { name: string; system_prompt: string; tools: OpenAITool[] },
		options: RequestOptions = {},
	): Promise<AssistantInfo> {
		return this.post<AssistantInfo>("/assistants", req, options);
	}

	private async listModelPages(
		path: string,
		params: Readonly<Record<string, string>>,
		options: RequestOptions,
	): Promise<ModelsListResponse> {
		const models: ModelCatalogItem[] = [];
		let skip = 0;
		let total = 0;

		while (true) {
			const page = await this.get<ModelsListResponse>(
				`${path}?${modelPageQuery(params, skip)}`,
				options,
			);
			models.push(...page.models);
			total = page.total;
			if (models.length >= total || page.models.length === 0) {
				return { models, total };
			}
			skip += page.models.length;
		}
	}

	private async listModelProviders(options: RequestOptions): Promise<string[]> {
		const result = await this.get<ProvidersListResponse>(
			"/models/providers",
			options,
		);
		return result.providers.filter(isSelectableProvider);
	}

	private async *postStream(
		path: string,
		body: unknown,
		options: RequestOptions,
		knownToolNames: readonly string[] = [],
	): AsyncIterable<ProviderEvent> {
		const isForm = body instanceof FormData;
		const headers = this.headers();
		if (isForm) delete headers["Content-Type"];
		const started = Date.now();
		let status = 0;
		let events = 0;
		const toolIdentityTrace: ToolMappingTrace[] = [];
		let lastEvent: ProviderEvent | null = null;
		let error: string | undefined;
		let errorLogged = false;

		this.serverLog?.request({
			endpoint: path,
			method: "POST",
			headers,
			body: isForm
				? { multipart: true, fields: Array.from((body as FormData).keys()) }
				: body,
		});

		const requestedThinking = isForm
			? undefined
			: (body as { thinking?: SendMessageRequest["thinking"] }).thinking;
		yield {
			kind: "thinking_resolved",
			requested: requestedThinking,
			effective: {
				thinking:
					requestedThinking === undefined ? "omitted" : requestedThinking,
				upstreamEffective: "unknown",
			},
			provider: "backboard",
			model: isForm
				? "request-model"
				: String(
						(body as { model_name?: string }).model_name ?? "thread-model",
					),
			reason: "backboard-wire-setting-upstream-mapping-not-observable",
		};
		try {
			const res = await fetch(`${this.env.apiUrl}${path}`, {
				method: "POST",
				headers,
				body: isForm ? (body as FormData) : JSON.stringify(body),
				signal: options.signal,
			});
			status = res.status;

			if (!res.ok) {
				const parsed = safeJson(await res.text());
				error = `HTTP ${status}`;
				errorLogged = true;
				this.serverLog?.response({
					endpoint: path,
					method: "POST",
					status,
					body: parsed,
					latencyMs: Date.now() - started,
					error,
				});
				throw new BackboardError(
					`Backboard request failed: HTTP ${status}`,
					status,
					parsed,
				);
			}
			if (!res.body) {
				throw new BackboardError(
					"Backboard stream response did not include a body",
					status,
					null,
				);
			}

			const mapper = new BackboardStreamEventMapper(
				knownToolNames,
				(trace) => {
					// Bounded metadata only. Raw argument text and private reasoning are never captured.
					if (
						trace.phase === "raw" &&
						process.env.BACKBOARD_TRACE_TOOL_FRAMES !== "1"
					)
						return;
					if (toolIdentityTrace.length < 256) toolIdentityTrace.push(trace);
				},
				process.env.BACKBOARD_TRACE_TOOL_FRAMES === "1",
			);
			for await (const frame of readSseFrames(res.body, {
				includeTransportActivity: true,
			})) {
				let payload: unknown;
				try {
					payload = parseSseFrame(frame);
				} catch (err) {
					error = errorMessage(err);
					const failure: ProviderEvent = {
						kind: "failed",
						error: `Malformed Backboard stream event: ${error}`,
					};
					events++;
					lastEvent = failure;
					yield failure;
					return;
				}
				const mapped = payload == null ? [] : mapper.map(payload);
				if (mapped.length === 0) mapped.push({ kind: "activity" });
				for (const event of mapped) {
					events++;
					lastEvent = event;
					if (event.kind === "failed") error = event.error;
					yield event;
					// A terminal protocol rejection cannot be followed by a successful
					// completion or another final batch, even for direct client consumers.
					// Reposting a consumed remote run has no documented idempotency contract.
					if (event.kind === "failed") return;
				}
			}
		} catch (err) {
			error ??= errorMessage(err);
			if (isAbortError(err) || err instanceof BackboardError) {
				throw err;
			}
			throw new BackboardTransportError(
				`Backboard stream failed for ${path}: ${error}`,
				path,
				status === 0 ? "request" : "stream",
				err,
			);
		} finally {
			if (!errorLogged) {
				this.serverLog?.response({
					endpoint: path,
					method: "POST",
					status,
					body: { stream: true, events, lastEvent, toolIdentityTrace },
					latencyMs: Date.now() - started,
					...(error ? { error } : {}),
				});
			}
		}
	}
}

function modelPageQuery(
	params: Readonly<Record<string, string>>,
	skip: number,
): string {
	const query = new URLSearchParams(params);
	query.set("skip", String(skip));
	query.set("limit", String(MODEL_PAGE_LIMIT));
	return query.toString();
}

function generatedVideoFromResponse(
	response: BackboardResponse,
): GenerateVideoResult | undefined {
	const media = [
		...(response.generated_media ?? []),
		...(response.messages ?? []).flatMap(
			(message) => message.generated_media ?? [],
		),
	];
	const video =
		media.find((item) => isVideoMedia(item)) ??
		media.find((item) => typeof item.url === "string");
	if (video?.url) {
		return {
			url: video.url,
			...(video.document_id ? { document_id: video.document_id } : {}),
		};
	}
	const fromContent = videoUrlFromText(response.content);
	return fromContent ? { url: fromContent } : undefined;
}

function isVideoMedia(item: GeneratedMediaInfo): boolean {
	const mediaType = item.media_type?.toLowerCase() ?? "";
	const mimeType = item.mime_type?.toLowerCase() ?? "";
	if (mediaType.includes("video") || mimeType.startsWith("video/")) {
		return true;
	}
	try {
		return /\.(?:mp4|webm|mov|m4v)(?:$|\?)/i.test(new URL(item.url).pathname);
	} catch {
		return false;
	}
}

function videoUrlFromText(content: string | null): string | undefined {
	if (!content) return undefined;
	const match =
		/!\[[^\]]*\]\(\s*(https:\/\/[^)\s]+)\s*\)/i.exec(content) ??
		/\[[^\]]*\]\(\s*(https:\/\/[^)\s]+)\s*\)/i.exec(content);
	return match?.[1];
}

function safeJson(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

function abortReason(signal: AbortSignal | undefined): unknown {
	return (
		signal?.reason ??
		new DOMException("The operation was aborted.", "AbortError")
	);
}

function sleepBeforeRetry(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortReason(signal));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

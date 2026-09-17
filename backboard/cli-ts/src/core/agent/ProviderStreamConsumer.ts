import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
	isRetryableStreamServerError,
	streamRetryDelayMs,
	streamServerErrorRetries,
} from "../../providers/backboard/streamRetry.ts";
import type { ProviderEvent } from "../../providers/backboard/types.ts";
import { ToolCallProtocolGuard } from "../../providers/ToolCallProtocolGuard.ts";
import { RetryableToolProtocolError } from "../../providers/ToolProtocolError.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import { emitPerformanceTiming } from "../performance/PerformanceTiming.ts";
import type { Session } from "../session/Session.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { EarlyToolSink } from "../tools/ToolScheduler.ts";
import type { AssistantAccumulator } from "./AssistantAccumulator.ts";
import {
	isModelAvailabilityError,
	isThinkingCompatibilityError,
} from "./RuntimeRecovery.ts";

export interface PendingAction {
	runId: string | null;
	calls: ToolCallRef[];
}

export interface ProviderStreamConsumerOptions {
	/** Buffer media-enabled responses so malformed provider HTML never reaches the UI. */
	imageGeneration?: boolean;
	/** Enables video generation; shares the buffering and persistence path. */
	videoGeneration?: boolean;
	/** Project directory where generated image bytes should be persisted. */
	generatedMediaDir?: string;
	/** Project directory where generated video bytes should be persisted. */
	generatedVideoDir?: string;
	/** Test seam for downloading generated media. */
	fetch?: (url: string) => Promise<Response>;
	/** Abort and retry a provider attempt that emits no events for this long. */
	idleTimeoutMs?: number;
	/** Override the shared provider retry count for latency-sensitive callers. */
	maxRetries?: number;
}

interface GeneratedMedia {
	url: string;
	label: string;
	/**
	 * Kind reported by the provider (`media_type`/`mime_type`). The URL shape is
	 * only a fallback: stored clips live under `/generated-video/`, which the
	 * path heuristics alone cannot be trusted to recognise.
	 */
	kind?: "image" | "video";
	savedPath?: string;
	contentHash?: string;
}

interface PersistedGeneratedMedia {
	path: string;
	contentHash: string;
}

class ProviderStreamFailure extends Error {
	constructor(
		message: string,
		readonly retryable?: boolean,
	) {
		super(message);
		this.name = "ProviderStreamFailure";
	}
}

export class ProviderStreamConsumer {
	constructor(
		private readonly bus: EventBus,
		private readonly session: Session,
		private readonly options: ProviderStreamConsumerOptions = {},
	) {}

	/** Image and video generation share the buffering and media-persistence path. */
	private get generativeMediaEnabled(): boolean {
		return Boolean(
			this.options.imageGeneration || this.options.videoGeneration,
		);
	}

	async consumeWithRetry(
		createStream: (signal: AbortSignal) => AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		signal: AbortSignal,
		earlyTools?: EarlyToolSink,
		onTerminalFailure?: () => Promise<string | null>,
		onRetry?: (error: unknown) => Promise<void> | void,
	): Promise<PendingAction | null> {
		const maxRetries = this.options.maxRetries ?? streamServerErrorRetries();
		let protocolRetryUsed = false;
		for (let attempt = 0; ; attempt++) {
			if (signal.aborted) throw new AbortError();
			const attemptController = new AbortController();
			const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
			try {
				return await this.consume(
					createStream(attemptSignal),
					assistant,
					earlyTools,
					attemptController,
					signal,
				);
			} catch (err) {
				// Any stream failure resets the early round: it retracts announced
				// rows and aborts early runs. On a retry the round is reused for
				// the next attempt; on a terminal throw this is the only cleanup -
				// the caller never reaches process(), whose finally is the usual
				// one, and a stranded pending row would pin the live region
				// forever.
				earlyTools?.reset();
				const safeProtocolRetry = err instanceof RetryableToolProtocolError;
				if (safeProtocolRetry) assistant.discardPartial();
				const terminal =
					err instanceof AbortError ||
					signal.aborted ||
					protocolRetryUsed ||
					(!safeProtocolRetry &&
						(!isRetryableProviderStreamFailure(err) || attempt >= maxRetries));
				if (terminal) {
					// Do not leave the coalescing timer able to publish reasoning after
					// the turn has already failed or been cancelled.
					assistant.flushReasoning();
					if (!(err instanceof AbortError) && !signal.aborted) {
						await preserveProviderContext(
							this.bus,
							onTerminalFailure,
							"cancelled provider context",
						);
					}
					throw signal.aborted ? new AbortError() : err;
				}
				if (safeProtocolRetry) {
					// Only an adapter that withheld its final tool batch may opt in.
					// Keep this single replay independent of transport retry budgets,
					// and do not change model/thinking settings for a protocol fault.
					protocolRetryUsed = true;
					this.bus.emit({
						type: "system:warning",
						message:
							"Retrying inconsistent tool response once. Unfinished reads were cancelled.",
					});
					continue;
				}
				await onRetry?.(err);
				assistant.discardPartial();
				try {
					await waitForRetry(streamRetryDelayMs(attempt + 1), signal);
				} catch (waitError) {
					await preserveProviderContext(
						this.bus,
						onTerminalFailure,
						"cancelled provider context",
					);
					throw waitError;
				}
			} finally {
				attemptController.abort();
			}
		}
	}

	private async consume(
		stream: AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		earlyTools?: EarlyToolSink,
		attemptController?: AbortController,
		signal?: AbortSignal,
	): Promise<PendingAction | null> {
		const toolProtocol = new ToolCallProtocolGuard();
		let bufferedText = "";
		const generatedMedia: GeneratedMedia[] = [];
		const providerRoundStartedAt = performance.now();
		let firstEvent = true;
		let firstVisible = true;
		let toolBatchStartedAt: number | undefined;
		const markToolAnnouncement = (): number => {
			if (toolBatchStartedAt !== undefined) return toolBatchStartedAt;
			toolBatchStartedAt = performance.now();
			emitPerformanceTiming(
				this.bus,
				"provider_tool_announcement",
				providerRoundStartedAt,
			);
			return toolBatchStartedAt;
		};
		const iterator = stream[Symbol.asyncIterator]();
		let reachedEnd = false;
		try {
			while (true) {
				const next = await this.nextEvent(iterator, attemptController, signal);
				if (next.done) {
					reachedEnd = true;
					break;
				}
				const event = toolProtocol.accept(next.value);
				if (
					firstEvent &&
					event.kind !== "thinking_resolved" &&
					event.kind !== "provider_diagnostic"
				) {
					firstEvent = false;
					emitPerformanceTiming(
						this.bus,
						"provider_first_event",
						providerRoundStartedAt,
					);
				}
				if (
					firstVisible &&
					(event.kind === "assistant_delta" ||
						event.kind === "reasoning_delta" ||
						event.kind === "tool_started" ||
						event.kind === "tool_ready")
				) {
					firstVisible = false;
					emitPerformanceTiming(
						this.bus,
						"provider_first_visible",
						providerRoundStartedAt,
					);
				}
				switch (event.kind) {
					case "activity":
						break;
					case "provider_diagnostic": {
						const { kind: _kind, ...diagnostic } = event;
						this.bus.emit({ type: "provider:diagnostic", ...diagnostic });
						break;
					}
					case "thinking_resolved": {
						const { kind: _kind, ...setting } = event;
						this.bus.emit({ type: "thinking:wire", ...setting });
						break;
					}
					case "thread":
						this.session.threadId = event.threadId;
						break;
					case "assistant_delta":
						if (event.text) {
							if (this.generativeMediaEnabled) bufferedText += event.text;
							else assistant.appendDelta(event.text);
						}
						break;
					case "reasoning_delta":
						if (event.text) assistant.appendReasoning(event.text);
						break;
					case "tool_started":
						assistant.flushAnswer();
						assistant.flushReasoning();
						markToolAnnouncement();
						if (isHostedMediaToolName(event.name)) {
							// Hosted media calls run inside the run server-side; no
							// requires_action arrives to close a scheduler-announced
							// row, which would end it retracted as "skipped". Emit a
							// plain start instead so the generated-media result below
							// completes this same card.
							this.pendingHostedMediaCalls[
								event.name === "generate_video" ? "video" : "image"
							].push(event.id);
							this.bus.emit({
								type: "tool:start",
								toolCallId: event.id,
								name: event.name,
								inputSummary: hostedMediaInputSummary(event.name, event.input),
							});
						} else {
							earlyTools?.announce(event.id, event.name);
						}
						break;
					case "tool_ready":
						assistant.flushAnswer();
						assistant.flushReasoning();
						markToolAnnouncement();
						earlyTools?.offer({
							id: event.call.id,
							name: event.call.name,
							input: event.call.input,
						});
						break;
					case "usage":
						this.session.addUsage(event.usage);
						this.bus.emit({ type: "usage", usage: event.usage });
						break;
					case "warning":
						this.bus.emit({ type: "system:warning", message: event.message });
						break;
					case "media": {
						const media = mediaFromPayload(event.payload);
						if (media) {
							await this.addGeneratedMedia(media, generatedMedia);
							this.emitMediaToolCall(media);
						} else {
							this.bus.emit({
								type: "system:warning",
								message: `Backboard sent generated media in an unrecognized shape (keys: ${Object.keys(event.payload).join(", ")}).`,
							});
						}
						break;
					}
					case "requires_action": {
						// Some providers still omit the advisory start/ready frames. Record
						// that entire silent generation interval instead of reporting only
						// the final few milliseconds after a late tool announcement.
						const finalizedBatchStartedAt = markToolAnnouncement();
						emitPerformanceTiming(
							this.bus,
							"provider_tool_batch_finalize",
							finalizedBatchStartedAt,
						);
						const calls = event.calls.map((call) => ({
							id: call.id,
							name: call.name,
							input: call.input,
						}));
						assistant.finalize(
							calls,
							this.generativeMediaEnabled
								? normalizeImageResponse(bufferedText, generatedMedia)
								: undefined,
						);
						return { runId: event.runId, calls };
					}
					case "failed":
						throw new ProviderStreamFailure(event.error, event.retryable);
					case "completed": {
						const finalText = event.finalText ?? bufferedText;
						if (this.generativeMediaEnabled) {
							// Some providers omit the media event and return the generated
							// Backboard URL only in final_content. Persist that response too.
							for (const media of mediaFromResponseText(finalText)) {
								await this.addGeneratedMedia(media, generatedMedia);
								this.emitMediaToolCall(media);
							}
						}
						assistant.finalize(
							[],
							this.generativeMediaEnabled
								? normalizeImageResponse(finalText, generatedMedia)
								: event.finalText,
						);
						return null;
					}
				}
			}
		} finally {
			emitPerformanceTiming(
				this.bus,
				"provider_stream_total",
				providerRoundStartedAt,
			);
			if (!reachedEnd) {
				attemptController?.abort();
				// Cleanup is best-effort after abort. An uncooperative iterator can
				// leave both next() and return() pending forever; awaiting return here
				// would defeat the idle watchdog and prevent the retry from starting.
				try {
					const cleanup = iterator.return?.();
					if (cleanup) void cleanup.catch(() => undefined);
				} catch {
					// A custom iterator may throw before returning a cleanup promise.
				}
			}
		}
		throw new ProviderStreamFailure(
			"Provider stream closed unexpectedly before a terminal event.",
			true,
		);
	}

	private async nextEvent(
		iterator: AsyncIterator<ProviderEvent>,
		attemptController: AbortController | undefined,
		signal: AbortSignal | undefined,
	): Promise<IteratorResult<ProviderEvent>> {
		const timeoutMs = this.options.idleTimeoutMs;
		if (signal?.aborted) throw new AbortError();
		if ((timeoutMs === undefined || timeoutMs <= 0) && !signal) {
			return iterator.next();
		}

		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			const races: PromiseLike<IteratorResult<ProviderEvent>>[] = [
				iterator.next(),
			];
			if (timeoutMs !== undefined && timeoutMs > 0) {
				races.push(
					new Promise<IteratorResult<ProviderEvent>>((_, reject) => {
						timeout = setTimeout(() => {
							reject(
								new ProviderStreamFailure(
									`Provider stream made no progress for ${timeoutMs}ms.`,
									true,
								),
							);
							attemptController?.abort();
						}, timeoutMs);
						timeout.unref?.();
					}),
				);
			}
			if (signal) {
				races.push(
					new Promise<IteratorResult<ProviderEvent>>((_, reject) => {
						onAbort = () => reject(new AbortError());
						signal.addEventListener("abort", onAbort, { once: true });
						if (signal.aborted) onAbort();
					}),
				);
			}
			return await Promise.race(races);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	private readonly emittedMediaToolCalls = new Set<string>();

	/** Server-announced hosted media call ids, completed by emitMediaToolCall. */
	private readonly pendingHostedMediaCalls = {
		image: [] as string[],
		video: [] as string[],
	};

	private emitMediaToolCall(media: GeneratedMedia): void {
		if (this.emittedMediaToolCalls.has(media.url)) return;
		this.emittedMediaToolCalls.add(media.url);
		const isVideo = isVideoMedia(media);
		const pending = this.pendingHostedMediaCalls[isVideo ? "video" : "image"];
		const toolCallId =
			pending.shift() ??
			`gen_${isVideo ? "video" : "image"}_${media.contentHash ?? randomUUID()}`;
		const toolName = isVideo ? "generate_video" : "generate_image";
		const inputSummary =
			media.label || (isVideo ? "Generating video…" : "Generating image…");
		this.bus.emit({
			type: "tool:start",
			toolCallId,
			name: toolName,
			inputSummary,
		});
		const saved = media.savedPath
			? `\n\nSaved to \`${projectRelativeGeneratedPath(media.savedPath)}\`.`
			: "";
		const detail = `![${media.label}](${media.url})${saved}`;
		this.bus.emit({
			type: "tool:result",
			toolCallId,
			name: toolName,
			title: isVideo ? "Video generated" : "Image generated",
			detail,
		});
	}

	private async addGeneratedMedia(
		media: GeneratedMedia,
		generatedMedia: GeneratedMedia[],
	): Promise<void> {
		if (generatedMedia.some((item) => item.url === media.url)) return;
		const persisted = await this.persistGeneratedMedia(
			media.url,
			this.mediaDirectoryFor(media),
		);
		media.savedPath = persisted?.path;
		media.contentHash = persisted?.contentHash;
		if (
			!media.contentHash ||
			!generatedMedia.some((item) => item.contentHash === media.contentHash)
		) {
			generatedMedia.push(media);
		}
	}

	/** Generated videos land in their own project folder so images stay separate. */
	private mediaDirectoryFor(media: GeneratedMedia): string | undefined {
		return isVideoMedia(media)
			? (this.options.generatedVideoDir ?? this.options.generatedMediaDir)
			: this.options.generatedMediaDir;
	}

	private async persistGeneratedMedia(
		url: string,
		directory: string | undefined,
	): Promise<PersistedGeneratedMedia | undefined> {
		if (!directory) return undefined;
		try {
			const response = await (this.options.fetch ?? fetch)(url);
			if (!response.ok) {
				throw new Error(`download returned HTTP ${response.status}`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength === 0) throw new Error("download was empty");
			await mkdir(directory, { recursive: true });
			const contentHash = createHash("sha256").update(bytes).digest("hex");
			const filename = generatedMediaFilename(
				contentHash,
				url,
				response.headers.get("content-type"),
			);
			const path = join(directory, filename);
			await writeFile(path, bytes);
			return { path, contentHash };
		} catch (error) {
			this.bus.emit({
				type: "system:warning",
				message: `Generated media could not be saved locally: ${errorMessage(error)}`,
			});
			return undefined;
		}
	}
}

export async function preserveProviderContext(
	bus: EventBus,
	callback: (() => Promise<string | null>) | undefined,
	label: string,
): Promise<void> {
	if (!callback) return;
	try {
		const warning = await callback();
		if (warning) bus.emit({ type: "system:warning", message: warning });
	} catch (error) {
		bus.emit({
			type: "system:warning",
			message: `Failed to preserve ${label}: ${errorMessage(error)}`,
		});
	}
}

function isRetryableProviderStreamFailure(error: unknown): boolean {
	if (
		error &&
		typeof error === "object" &&
		"category" in error &&
		error.category === "protocol"
	)
		return false;
	if (isModelAvailabilityError(error) || isThinkingCompatibilityError(error)) {
		return true;
	}
	if (error instanceof ProviderStreamFailure) {
		return error.retryable ?? isRetryableStreamServerError(error);
	}
	return isRetryableStreamServerError(error);
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw new AbortError();
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new AbortError());
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function mediaFromPayload(
	payload: Record<string, unknown>,
): GeneratedMedia | null {
	const url =
		mediaUrlField(payload) ??
		mediaUrlField(payload.media) ??
		mediaUrlField(payload.data) ??
		mediaUrlField(payload.image) ??
		mediaUrlField(payload.chunk);
	if (!url) return null;
	const kind = mediaKindFromPayload(payload);
	const label =
		typeof payload.prompt === "string" && payload.prompt.trim()
			? payload.prompt.trim()
			: defaultMediaLabel(kind, url);
	return { url, label: label.replace(/[[\]]/g, ""), ...(kind ? { kind } : {}) };
}

function mediaFromResponseText(text: string): GeneratedMedia[] {
	const media: GeneratedMedia[] = [];
	const add = (url: string, label: string) => {
		if (
			isBackboardGeneratedMediaUrl(url) &&
			!media.some((item) => item.url === url)
		) {
			media.push({
				url,
				label:
					label.replace(/[[\]]/g, "").trim() ||
					defaultMediaLabel(undefined, url),
			});
		}
	};

	for (const match of text.matchAll(
		/!\[([^\]]*)\]\(\s*(https:\/\/[^)\s]+)\s*\)/gi,
	)) {
		add(match[2] ?? "", match[1] ?? "Generated image");
	}
	// Generated videos can arrive as a plain link instead of image markdown.
	for (const match of text.matchAll(
		/\[([^\]]*)\]\(\s*(https:\/\/[^)\s]+)\s*\)/gi,
	)) {
		add(match[2] ?? "", match[1] ?? "Generated video");
	}
	for (const match of text.matchAll(/\\?<img\b[^>]*>/gi)) {
		const tag = match[0];
		const url = /\bsrc=["'](https:\/\/[^"']+)["']/i.exec(tag)?.[1];
		const label = /\balt=["']([^"']*)["']/i.exec(tag)?.[1];
		if (url) add(url, label ?? "Generated image");
	}
	return media;
}

function isBackboardGeneratedMediaUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "backboard-prod.s3.ca-central-1.amazonaws.com" &&
			/^\/generated-(?:images?|videos?)\//.test(url.pathname)
		);
	} catch {
		return false;
	}
}

/**
 * Generated clips use the `generated-video`/`generated-videos` bucket prefix;
 * the extension decides anything else (uploads, provider mirrors).
 */
function isVideoMediaUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			/^\/generated-videos?\//.test(url.pathname) ||
			/[.](?:mp4|webm|mov|m4v)$/i.test(url.pathname)
		);
	} catch {
		return false;
	}
}

/** Explicit provider metadata wins over the URL shape when classifying media. */
function isVideoMedia(media: GeneratedMedia): boolean {
	return media.kind ? media.kind === "video" : isVideoMediaUrl(media.url);
}

/**
 * Backboard's hosted media tools: the server announces them in `tool_calls`
 * frames and executes them inside the run, so no requires_action follows.
 */
function isHostedMediaToolName(name: string): boolean {
	return name === "generate_video" || name === "generate_image";
}

/** Pending-row label for a hosted media call, using the prompt when present. */
function hostedMediaInputSummary(name: string, input: unknown): string {
	const fallback =
		name === "generate_video" ? "Generating video…" : "Generating image…";
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return fallback;
	}
	const prompt = (input as Record<string, unknown>).prompt;
	if (typeof prompt !== "string" || !prompt.trim()) return fallback;
	const trimmed = prompt.trim();
	return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/**
 * Reads `media_type`/`mime_type` (documented `generated_media` fields) from a
 * media event so a clip is classified correctly even when its URL carries no
 * video extension.
 */
function mediaKindFromPayload(
	payload: Record<string, unknown>,
): "image" | "video" | undefined {
	for (const value of [
		payload,
		payload.media,
		payload.data,
		payload.image,
		payload.chunk,
	]) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const record = value as Record<string, unknown>;
		const declared =
			typeof record.media_type === "string"
				? record.media_type.trim().toLowerCase()
				: "";
		if (declared === "video" || declared === "image") return declared;
		const mime =
			typeof record.mime_type === "string"
				? record.mime_type.trim().toLowerCase()
				: "";
		if (mime.startsWith("video/")) return "video";
		if (mime.startsWith("image/")) return "image";
	}
	return undefined;
}

function defaultMediaLabel(
	kind: "image" | "video" | undefined,
	url: string,
): string {
	return (kind ?? (isVideoMediaUrl(url) ? "video" : "image")) === "video"
		? "Generated video"
		: "Generated image";
}

function normalizeImageResponse(text: string, media: GeneratedMedia[]): string {
	let normalized = text
		// Backboard may return an escaped HTML tag whose src itself contains a
		// markdown link. It is invalid in both HTML and markdown, so remove it.
		.replace(/\\?<img\b[^>]*>/gi, "")
		.trim();
	if (media.length > 0) {
		// The media event is authoritative for this turn. Drop image markdown from
		// final_content so an older conversation image cannot be repeated.
		normalized = normalized
			.replace(/!\[[^\]]*\]\(\s*(?:https?:\/\/|data:image\/)[^)]+\)/gi, "")
			.trim();
		for (const item of media) {
			normalized = normalized.split(item.url).join("");
		}
		normalized = normalized
			.replace(/\[[^\]]+\]\(\s*\)/g, "")
			.replace(/:\s*$/, ".")
			.trim();
		normalized = dedupeParagraphs(normalized);
	}

	const rendered = media.map((item) => {
		const saved = item.savedPath
			? `\n\nSaved to \`${projectRelativeGeneratedPath(item.savedPath)}\`.`
			: "";
		return `![${item.label}](${item.url})${saved}`;
	});
	return [normalized, ...rendered].filter(Boolean).join("\n\n");
}

function dedupeParagraphs(text: string): string {
	const seen = new Set<string>();
	return text
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => {
			if (!paragraph || seen.has(paragraph)) return false;
			seen.add(paragraph);
			return true;
		})
		.join("\n\n");
}

function generatedMediaFilename(
	contentHash: string,
	url: string,
	contentType: string | null,
): string {
	let sourceExtension = "";
	try {
		sourceExtension = extname(new URL(url).pathname).toLowerCase();
	} catch {
		// Data URLs and malformed provider URLs fall through to content type.
	}
	const extension = /^[.](?:png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v)$/.test(
		sourceExtension,
	)
		? sourceExtension === ".jpeg"
			? ".jpg"
			: sourceExtension
		: extensionForContentType(contentType);
	return `generated-${contentHash.slice(0, 12)}${extension}`;
}

function extensionForContentType(contentType: string | null): string {
	const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	if (type === "image/png") return ".png";
	if (type === "image/webp") return ".webp";
	if (type === "image/gif") return ".gif";
	if (type === "image/avif") return ".avif";
	if (type === "video/mp4") return ".mp4";
	if (type === "video/webm") return ".webm";
	if (type === "video/quicktime") return ".mov";
	return ".jpg";
}

function projectRelativeGeneratedPath(path: string): string {
	for (const folder of ["generated-videos", "generated-images"]) {
		const index = path.lastIndexOf(`${join(folder, "")}`);
		if (index >= 0) return path.slice(index);
	}
	return path;
}

function mediaUrlField(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	for (const key of ["url", "image_url", "imageUrl", "media_url", "href"]) {
		const candidate = record[key];
		if (
			typeof candidate === "string" &&
			/^(https?:|data:image\/)/.test(candidate)
		) {
			return candidate;
		}
	}
	return null;
}

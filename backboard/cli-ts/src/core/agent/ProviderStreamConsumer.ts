import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
	isRetryableStreamServerError,
	streamRetryDelayMs,
	streamServerErrorRetries,
} from "../../providers/backboard/streamRetry.ts";
import type { ProviderEvent } from "../../providers/backboard/types.ts";
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
	/** Buffer image-enabled responses so malformed provider HTML never reaches the UI. */
	imageGeneration?: boolean;
	/** Project directory where generated image bytes should be persisted. */
	generatedMediaDir?: string;
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
		readonly retryable: boolean,
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

	async consumeWithRetry(
		createStream: (signal: AbortSignal) => AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		signal: AbortSignal,
		earlyTools?: EarlyToolSink,
		onTerminalFailure?: () => Promise<string | null>,
		onRetry?: (error: unknown) => Promise<void> | void,
	): Promise<PendingAction | null> {
		const maxRetries = this.options.maxRetries ?? streamServerErrorRetries();
		for (let attempt = 0; ; attempt++) {
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
				const terminal =
					err instanceof AbortError ||
					signal.aborted ||
					!isRetryableProviderStreamFailure(err) ||
					attempt >= maxRetries;
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
					throw err;
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
		let bufferedText = "";
		const generatedMedia: GeneratedMedia[] = [];
		const providerRoundStartedAt = performance.now();
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
				const event = next.value;
				switch (event.kind) {
					case "activity":
						break;
					case "thread":
						this.session.threadId = event.threadId;
						break;
					case "assistant_delta":
						if (event.text) {
							if (this.options.imageGeneration) bufferedText += event.text;
							else assistant.appendDelta(event.text);
						}
						break;
					case "reasoning_delta":
						if (event.text) assistant.appendReasoning(event.text);
						break;
					case "tool_started":
						assistant.flushReasoning();
						markToolAnnouncement();
						earlyTools?.announce(event.id, event.name);
						break;
					case "tool_ready":
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
							this.options.imageGeneration
								? normalizeImageResponse(bufferedText, generatedMedia)
								: undefined,
						);
						return { runId: event.runId, calls };
					}
					case "failed":
						throw new ProviderStreamFailure(
							event.error,
							event.retryable === true,
						);
					case "completed": {
						const finalText = event.finalText ?? bufferedText;
						if (this.options.imageGeneration) {
							// Some providers omit the media event and return the generated
							// Backboard URL only in final_content. Persist that response too.
							for (const media of mediaFromResponseText(finalText)) {
								await this.addGeneratedMedia(media, generatedMedia);
							}
						}
						assistant.finalize(
							[],
							this.options.imageGeneration
								? normalizeImageResponse(finalText, generatedMedia)
								: event.finalText,
						);
						return null;
					}
				}
			}
		} finally {
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

	private async addGeneratedMedia(
		media: GeneratedMedia,
		generatedMedia: GeneratedMedia[],
	): Promise<void> {
		if (generatedMedia.some((item) => item.url === media.url)) return;
		const persisted = await this.persistGeneratedMedia(media.url);
		media.savedPath = persisted?.path;
		media.contentHash = persisted?.contentHash;
		if (
			!media.contentHash ||
			!generatedMedia.some((item) => item.contentHash === media.contentHash)
		) {
			generatedMedia.push(media);
		}
	}

	private async persistGeneratedMedia(
		url: string,
	): Promise<PersistedGeneratedMedia | undefined> {
		const directory = this.options.generatedMediaDir;
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
				message: `Generated image could not be saved locally: ${errorMessage(error)}`,
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
	if (isModelAvailabilityError(error) || isThinkingCompatibilityError(error)) {
		return true;
	}
	if (error instanceof ProviderStreamFailure) {
		return error.retryable || isRetryableStreamServerError(error);
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
	const label =
		typeof payload.prompt === "string" && payload.prompt.trim()
			? payload.prompt.trim()
			: "Generated image";
	return { url, label: label.replace(/[[\]]/g, "") };
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
				label: label.replace(/[[\]]/g, "").trim() || "Generated image",
			});
		}
	};

	for (const match of text.matchAll(
		/!\[([^\]]*)\]\(\s*(https:\/\/[^)\s]+)\s*\)/gi,
	)) {
		add(match[2] ?? "", match[1] ?? "Generated image");
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
			url.pathname.startsWith("/generated-images/")
		);
	} catch {
		return false;
	}
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
	const extension = /^[.](?:png|jpe?g|webp|gif|avif)$/.test(sourceExtension)
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
	return ".jpg";
}

function projectRelativeGeneratedPath(path: string): string {
	const marker = `${join("generated-images", "")}`;
	const index = path.lastIndexOf(marker);
	return index >= 0 ? path.slice(index) : path;
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

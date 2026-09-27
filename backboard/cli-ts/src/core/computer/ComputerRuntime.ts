import type { ModelRoute } from "../../providers/backboard/types.ts";
import { canonicalAppName } from "../../utils/appNames.ts";
import { errorMessage } from "../../utils/errors.ts";
import { createPlatform, type Platform } from "../platform/index.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { ComputerPaths } from "./ComputerPaths.ts";
import { toPlatformAction } from "./ComputerPlatformAction.ts";
import type {
	ComputerAction,
	ComputerActionResult,
	ComputerObservation,
	ComputerQueueResult,
	JevTaskResult,
} from "./ComputerTypes.ts";
import { CuaBrowserSurface } from "./CuaBrowserSurface.ts";
import {
	CuaDriverSurface,
	isBrowserApp,
	resolveCuaDriverBinary,
	type ScreenshotPaths,
} from "./CuaDriverSurface.ts";
import { describeStep, JevSubagent } from "./JevSubagent.ts";
import {
	type ComputerBrain,
	type JevSurface,
	JevUseLoop,
	type JevWriterPacket,
} from "./JevUseLoop.ts";
import { PlatformJevSurface } from "./PlatformJevSurface.ts";
import { ScreenCapture } from "./ScreenCapture.ts";

/**
 * The writer is a model request, so it must be billed on the route the user's
 * turn was captured with. The IDE's host-managed runtime refuses any request
 * without one, which killed every task at its first TYPE_TEXT.
 */
export type RoutedJevWriter = (
	packet: JevWriterPacket,
	options: { signal: AbortSignal; modelRoute?: Readonly<ModelRoute> },
) => Promise<string | null>;

/** What a brain is built with, once per task. */
export interface ComputerBrainContext {
	/** The route the user's turn was captured with, for billing and fallback. */
	modelRoute?: Readonly<ModelRoute>;
	/** Streams a status line into the task's tool card. */
	onStatus: (message: string) => void;
}

export interface ComputerRuntimeOptions {
	platform?: Platform;
	/** Chooses every step of a task; without it `task` actions are refused. */
	brain?: (context: ComputerBrainContext) => ComputerBrain;
	/** Composes drawings, and text for a brain that can only choose. */
	jevWriter?: RoutedJevWriter;
	/** Injectable for tests; defaults to the bundled or installed Cua Driver. */
	resolveCuaDriver?: () => string | undefined;
	browserFactory?: (
		path: string,
		name: string,
		screenshots: ScreenshotPaths,
	) => CuaBrowserSurface;
}

export class ComputerRuntime {
	private readonly platform: Platform;
	private readonly brain?: (context: ComputerBrainContext) => ComputerBrain;
	private readonly jevWriter?: RoutedJevWriter;
	private readonly resolveCuaDriver: () => string | undefined;
	private lastObservation: ComputerObservation | null = null;
	private readonly browsers = new Map<string, CuaBrowserSurface>();
	private readonly browserFactory: (
		path: string,
		name: string,
		screenshots: ScreenshotPaths,
	) => CuaBrowserSurface;

	constructor(options: ComputerRuntimeOptions = {}) {
		this.platform = options.platform ?? createPlatform();
		this.brain = options.brain;
		this.jevWriter = options.jevWriter;
		this.resolveCuaDriver = options.resolveCuaDriver ?? resolveCuaDriverBinary;
		this.browserFactory =
			options.browserFactory ??
			((path, name, screenshots) =>
				new CuaBrowserSurface(path, name, undefined, screenshots));
	}

	async execute(
		actions: ComputerAction[],
		ctx: ToolContext,
		options: { defaultDelayMs?: number; stopOnError?: boolean } = {},
	): Promise<ComputerQueueResult> {
		const results: ComputerQueueResult["results"] = [];
		for (const action of actions) {
			if (ctx.signal.aborted) throw new Error("aborted");
			if (results.length > 0 && options.defaultDelayMs) {
				await delay(options.defaultDelayMs, ctx.signal);
			}
			const result = await this.executeOne(action, ctx);
			results.push(result);
			if (!result.success && options.stopOnError !== false) break;
		}
		if (
			actions.length > 1 &&
			results.every((r) => r.success) &&
			actions[actions.length - 1]?.action !== "screenshot" &&
			actions[actions.length - 1]?.action !== "task"
		) {
			const observation = await new ScreenCapture(
				ctx.sessionId,
				this.platform,
			).capture(ctx.signal);
			this.lastObservation = observation;
			results.push(observation);
		}
		return {
			success: results.every((r) => r.success),
			results,
		};
	}

	private async executeOne(
		action: ComputerAction,
		ctx: ToolContext,
	): Promise<ComputerObservation | ComputerActionResult> {
		if (action.action === "screenshot") {
			if (action.appName) {
				// This image is window-relative evidence, not a desktop-coordinate
				// observation authorizing direct clicks on whichever app is foreground.
				this.lastObservation = null;
				const surface = this.browsers.get(
					canonicalAppName(action.appName).toLowerCase(),
				);
				if (!surface)
					return {
						success: false,
						action: "screenshot",
						verification: "failed",
						summary: `No active computer-use browser for ${action.appName}. Start a task in that app first.`,
					};
				try {
					return {
						success: true,
						action: "screenshot",
						verification: "unknown",
						summary: `Captured the exact ${action.appName} task window. Coordinates are window-relative; continue with a task action.`,
						...(await surface.capture(
							await new ComputerPaths(ctx.sessionId).nextScreenshotPath(),
							ctx.signal,
						)),
					};
				} catch (error) {
					return {
						success: false,
						action: "screenshot",
						verification: "failed",
						summary: `Could not capture ${action.appName}.`,
						error: errorMessage(error),
					};
				}
			}
			const observation = await new ScreenCapture(
				ctx.sessionId,
				this.platform,
			).capture(ctx.signal);
			this.lastObservation = observation;
			return observation;
		}
		if (action.action === "wait") {
			await delay(action.durationMs, ctx.signal);
			return {
				success: true,
				action: action.action,
				observationId: this.lastObservation?.observationId,
				verification: "unknown",
				summary: `Waited ${action.durationMs}ms.`,
			};
		}

		if (action.action === "task") return this.runJevTask(action, ctx);

		const validation = this.validateAction(action);
		if (validation) return validation;

		try {
			await this.platform.execute(
				toPlatformAction(action, this.lastObservation),
				ctx.signal,
			);
			const result: ComputerActionResult = {
				success: true,
				action: action.action,
				observationId: this.lastObservation?.observationId,
				verification: "unknown",
				summary: `Executed ${action.action}.`,
			};
			const observation = await this.capturePostActionObservation(action, ctx);
			if (!observation) return result;
			return {
				...result,
				observationId: observation.observationId,
				verification: "passed",
				summary: `${result.summary} Captured updated screenshot.`,
				observation,
			};
		} catch (err) {
			return {
				success: false,
				action: action.action,
				observationId: this.lastObservation?.observationId,
				verification: "failed",
				summary: `Failed to execute ${action.action}.`,
				error: errorMessage(err),
			};
		}
	}

	/**
	 * Hands a goal to the computer-use agent. Prefers the Cua Driver, which
	 * presses elements in the background; without it the built-in platform layer
	 * drives the real pointer.
	 */
	private async runJevTask(
		action: Extract<ComputerAction, { action: "task" }>,
		ctx: ToolContext,
	): Promise<JevTaskResult | ComputerActionResult> {
		if (!this.brain || !this.jevWriter) {
			return {
				success: false,
				action: "task",
				verification: "failed",
				summary: "Computer-use tasks are unavailable.",
				error:
					"No computer-use model is configured. Sign in to Backboard, or use direct actions instead.",
			};
		}
		const driver = this.resolveCuaDriver();
		// Each look is kept beside the session's other screenshots.
		const paths = new ComputerPaths(ctx.sessionId);
		const screenshots = () => paths.nextScreenshotPath();
		let surface: JevSurface;
		try {
			if (isBrowserApp(action.appName)) {
				if (!driver)
					throw new Error(
						"Cua Driver is unavailable. Browser tasks require its DOM and canvas support.",
					);
				if (/\b(safari|firefox|orion)\b/i.test(action.appName)) {
					throw new Error(
						`${action.appName} does not support the driver's DOM/canvas route. Use Brave, Chrome, or Edge; when the user did not specify a browser, use appName "Browser". Do not retry this task through browser toolbar accessibility.`,
					);
				}
				surface = await this.browserSurface(
					driver,
					action.appName,
					screenshots,
					ctx.signal,
				);
			} else {
				surface = driver
					? new CuaDriverSurface(driver, action.appName, screenshots)
					: new PlatformJevSurface(this.platform, action.appName);
			}
		} catch (error) {
			if (ctx.signal.aborted) throw error;
			return {
				success: false,
				action: "task",
				verification: "failed",
				summary: `Could not prepare computer use in ${action.appName}.`,
				error: errorMessage(error),
			};
		}
		// Shown to a host as a sub-agent of this tool call, named after its brain.
		const subagent = ctx.toolCallId
			? new JevSubagent(ctx.bus, ctx.toolCallId)
			: undefined;
		const progress = (line: string) => {
			if (!ctx.toolCallId) return;
			ctx.bus.emit({
				type: "tool:progress",
				toolCallId: ctx.toolCallId,
				data: { kind: "terminal-output", text: `${line}\n` },
			});
		};
		const brain = this.brain({
			modelRoute: ctx.modelRoute,
			onStatus: (message) => progress(`${message}...`),
		});
		subagent?.start(brain.name, action.appName, action.goal);
		try {
			// Any earlier screenshot is stale once the agent has pressed things.
			this.lastObservation = null;
			const writer = this.jevWriter;
			const result = await new JevUseLoop(surface, brain, (packet, options) =>
				writer(packet, { ...options, modelRoute: ctx.modelRoute }),
			).run(
				{
					goal: action.goal,
					maxSteps: action.maxSteps,
					onStepStart: (step) => subagent?.stepStarted(step),
					onStep: (step) => {
						subagent?.stepFinished(step);
						// Also streamed as text, for hosts that do not render sub-agents.
						progress(`${step.step}. ${describeStep(step)}`);
					},
					onStatus: (message) => progress(`${message}...`),
					// A spawned sub-agent cannot prompt the user; without `ask` the run
					// hands sign-ins and consequential controls back to its caller.
					...((ctx.agentDepth ?? 0) === 0
						? {
								ask: (
									question: string,
									choices: string[],
									signal: AbortSignal,
								) => ctx.askUser(question, choices, signal),
							}
						: {}),
				},
				ctx.signal,
			);
			subagent?.endWith(result);
			if (surface instanceof CuaBrowserSurface && !ctx.signal.aborted) {
				try {
					return {
						...result,
						...(await surface.capture(
							await new ComputerPaths(ctx.sessionId).nextScreenshotPath(),
							ctx.signal,
						)),
					};
				} catch (error) {
					return {
						...result,
						summary: `${result.summary} Final screenshot unavailable: ${errorMessage(error)}`,
					};
				}
			}
			return result;
		} catch (err) {
			subagent?.end(ctx.signal.aborted ? "cancelled" : "failed");
			throw err;
		} finally {
			if (surface instanceof CuaDriverSurface) await surface.dispose();
		}
	}

	/**
	 * The DOM-driven browser, shared by every task of this runtime: closing it
	 * with each task would throw away the page the user asked to be taken to.
	 * Preparation errors remain visible. Falling back to browser toolbar-only
	 * accessibility silently removes DOM/canvas support and can loop indefinitely.
	 */
	private async browserSurface(
		driver: string,
		appName: string,
		screenshots: ScreenshotPaths,
		signal: AbortSignal,
	): Promise<CuaBrowserSurface> {
		const key = canonicalAppName(appName).toLowerCase();
		const existing = this.browsers.get(key);
		if (existing) return existing;
		const surface = this.browserFactory(driver, appName, screenshots);
		try {
			await surface.observe(signal);
			this.browsers.set(key, surface);
			return surface;
		} catch (error) {
			await surface.dispose().catch(() => {});
			throw error;
		}
	}

	async dispose(): Promise<void> {
		const browsers = [...this.browsers.values()];
		this.browsers.clear();
		await Promise.all(browsers.map((browser) => browser.dispose()));
	}

	private validateAction(action: ComputerAction): ComputerActionResult | null {
		if (!requiresObservation(action)) return null;
		if (!this.lastObservation) {
			return {
				success: false,
				action: action.action,
				verification: "failed",
				summary: "A fresh screenshot is required before this action.",
				error:
					'Call Computer with {"actions":[{"action":"screenshot"}]} before acting on the screen.',
			};
		}
		return null;
	}

	private async capturePostActionObservation(
		action: ComputerAction,
		ctx: ToolContext,
	): Promise<ComputerObservation | null> {
		if (action.action === "type" || action.action === "key") return null;
		await delay(action.action === "openApp" ? 1200 : 300, ctx.signal);
		const observation = await new ScreenCapture(
			ctx.sessionId,
			this.platform,
		).capture(ctx.signal);
		this.lastObservation = observation;
		return observation;
	}
}

function requiresObservation(action: ComputerAction): boolean {
	switch (action.action) {
		case "click":
			return true;
		default:
			return false;
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

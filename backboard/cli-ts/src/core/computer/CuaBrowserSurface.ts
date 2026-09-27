import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalAppName } from "../../utils/appNames.ts";
import { errorMessage } from "../../utils/errors.ts";
import { ImageContent } from "../image/ImageContent.ts";
import type { CanvasDrawing } from "./CanvasDrawing.ts";
import { CUA_SESSION, CuaDriverClient } from "./CuaDriverClient.ts";
import {
	SCREENSHOT_MAX_DIMENSION,
	type ScreenshotPaths,
	screenImage,
	showAgentCursor,
} from "./CuaDriverSurface.ts";
import {
	type JevElement,
	type JevKey,
	type JevObservation,
	type JevSurface,
	type ScreenImage,
	visibleText,
} from "./JevUseLoop.ts";

/** One action ref from a `semantic_v2` snapshot. */
interface PageRef {
	ref?: string;
	role?: string;
	name?: string | null;
	value?: string | null;
	actions?: string[];
	states?: Record<string, unknown>;
	visibility?: "in_viewport" | "near_viewport" | "offscreen" | string;
}

interface PageSnapshot {
	page?: { title?: string; url?: string };
	refs?: PageRef[];
	outline?: string;
}

interface DriverWindow {
	pid: number;
	window_id: number;
	is_on_screen?: boolean;
	bounds?: { width: number; height: number };
}

/**
 * One driver-owned profile per browser, kept on disk across tasks: a site the
 * user signs in to once stays signed in, and their everyday browser profile is
 * never read. `backboard` for "Browser", `backboard-brave-browser` for Brave.
 */
export function agentProfileName(appName: string): string {
	if (/^browser$/i.test(appName.trim())) return "backboard";
	const slug = canonicalAppName(appName)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return `backboard-${slug}`.slice(0, 64);
}
/**
 * Stopping the driver ends its browser abruptly, so the next launch of the
 * persistent profile opened with Chrome's "Restore pages?" bubble. The bubble
 * is its own native window: clicks on the screenshot fell through to the page,
 * and a live run spent five steps on it. Marking the last exit clean before
 * launch prevents it. Only the driver-owned profile is touched.
 */
export function markProfileExitedCleanly(
	profileName: string,
	root = process.env.CUA_DRIVER_BROWSER_PROFILE_ROOT ??
		join(
			homedir(),
			"Library",
			"Application Support",
			"CuaDriver",
			"BrowserProfiles",
		),
): void {
	const file = join(root, profileName, "Default", "Preferences");
	try {
		const prefs = JSON.parse(readFileSync(file, "utf8")) as {
			profile?: Record<string, unknown>;
		};
		prefs.profile = {
			...prefs.profile,
			exit_type: "Normal",
			exited_cleanly: true,
		};
		writeFileSync(file, JSON.stringify(prefs));
	} catch {
		// A profile that has never run has no preferences yet.
	}
}

const BIND_ATTEMPTS = 40;
const BIND_WAIT_MS = 400;
const SCROLL_PX = 600;
const VISIBILITY_RANK: Record<string, number> = {
	in_viewport: 0,
	near_viewport: 1,
	offscreen: 2,
};

/** Roles that are controls in their own right rather than a control's contents. */
const CONTROL_ROLES =
	/^(link|button|textbox|searchbox|combobox|listbox|option|checkbox|radio|switch|slider|spinbutton|tab|menuitem|menuitemcheckbox|menuitemradio|treeitem|gridcell|row)$/;

/**
 * A browser driven through the DOM rather than the accessibility tree.
 *
 * The accessibility view of a web app is a lossy projection: it mixed the
 * browser's own toolbar into the page, hid a dialog's fields, and left a real
 * run looping on Pixlr's "Create new". Here the Cua Driver's `semantic_v2`
 * snapshot joins the DOM, accessibility, layout, and viewport, ranks visible
 * controls first, and says which actions each one takes; clicks and typing go
 * to those refs over the DevTools protocol.
 *
 * The browser is a separate, driver-owned instance of the requested browser
 * with Backboard's own persistent profile. It shares nothing with the user's
 * everyday profile, and the driver closes it when this surface is disposed.
 */
export class CuaBrowserSurface implements JevSurface {
	readonly kind = "cua-browser-dom";
	private readonly driver: Pick<CuaDriverClient, "call" | "tryCall" | "close">;
	/** A label repeated on every call so the driver keeps one browser session. */
	private readonly session = CUA_SESSION;
	private target: {
		pid: number;
		window_id: number;
		target_id: string;
		tab_id: string;
	} | null = null;
	private title = "";
	private lastElements: JevElement[] = [];
	private scrollRef: string | undefined;
	/** Role and label of the field last typed into, so Return can find it again. */
	private lastTyped: { role: string; label?: string } | null = null;

	constructor(
		binaryPath: string,
		readonly appName = "Browser",
		driver?: Pick<CuaDriverClient, "call" | "tryCall" | "close">,
		private readonly screenshots?: ScreenshotPaths,
	) {
		this.driver = driver ?? new CuaDriverClient(binaryPath);
	}

	async observe(signal: AbortSignal): Promise<JevObservation> {
		const target = await this.bind(signal);
		const snapshot = await this.readSnapshot(
			"get_browser_state",
			{
				target_id: target.target_id,
				tab_id: target.tab_id,
				snapshot_format: "semantic_v2",
				session: this.session,
			},
			signal,
		);
		this.title = snapshot.page?.title ?? "";
		this.lastElements = elementsFromRefs(snapshot.refs ?? []);
		this.scrollRef = snapshot.refs?.find(
			(ref) =>
				ref.actions?.includes("scroll") && ref.visibility === "in_viewport",
		)?.ref;
		const screenshot = await this.screenshot(target, signal);
		return {
			appName: this.appName,
			windowTitle: [snapshot.page?.title, snapshot.page?.url]
				.filter(Boolean)
				.join(" - "),
			elements: this.lastElements,
			text: visibleText(outlineText(snapshot.outline ?? "")),
			...(screenshot ? { screenshot } : {}),
		};
	}

	/** The window as the user sees it, for a brain that reads screenshots. */
	private async screenshot(
		target: { pid: number; window_id: number },
		signal: AbortSignal,
	): Promise<ScreenImage | undefined> {
		const path = await this.screenshots?.();
		if (!path) return undefined;
		const captured = await this.driver.tryCall<{
			screenshot_width?: number;
			screenshot_height?: number;
		}>(
			"get_window_state",
			{
				pid: target.pid,
				window_id: target.window_id,
				include_accessibility_tree: false,
				screenshot_out_file: path,
				max_dimension: SCREENSHOT_MAX_DIMENSION,
			},
			signal,
		);
		// A page is still operable from its DOM when the capture fails.
		return captured.ok ? screenImage(path, captured.data) : undefined;
	}

	/**
	 * A point of the window screenshot, for what the DOM snapshot does not offer.
	 * It is a native click posted to the browser: the page's trusted click route
	 * refuses background windows on macOS.
	 */
	async pressAt(
		x: number,
		y: number,
		_screenshot: ScreenImage,
		signal: AbortSignal,
	): Promise<void> {
		const target = await this.bind(signal);
		await this.driver.call(
			"click",
			{ pid: target.pid, window_id: target.window_id, x, y },
			signal,
		);
	}

	/** Frames can disappear while an ad or navigation loads. Retrying a read
	 * obtains a new snapshot; a browser mutation is never replayed here. */
	private async readSnapshot(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<PageSnapshot> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.driver.call<PageSnapshot>(name, args, signal);
			} catch (error) {
				if (
					signal.aborted ||
					attempt >= 3 ||
					!/Frame with the given frameId is not found|Execution context was destroyed|Cannot find context with specified id|document.*changed/i.test(
						errorMessage(error),
					)
				)
					throw error;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
	}

	async press(element: JevElement, signal: AbortSignal): Promise<void> {
		const target = await this.bind(signal);
		const args = {
			target_id: target.target_id,
			tab_id: target.tab_id,
			ref: element.handle,
			session: this.session,
		};
		// Explicit synthetic input preserves macOS background posture. Never retry
		// a failed mutation: its event handlers may already have run.
		await this.driver.call(
			"browser_click",
			{ ...args, input_route: "dom_event" },
			signal,
		);
	}

	async draw(
		element: JevElement,
		drawing: CanvasDrawing,
		signal: AbortSignal,
	): Promise<void> {
		const target = await this.bind(signal);
		// One bounded plan lets the driver fit and preflight every stroke before
		// sending any brush-down event. Unknown/partial failures are never replayed.
		await this.driver.call(
			"browser_pointer",
			{
				target_id: target.target_id,
				tab_id: target.tab_id,
				session: this.session,
				action: "drag",
				input_route: "dom_event",
				ref: element.handle,
				strokes: drawing.strokes,
			},
			signal,
		);
	}

	async type(
		element: JevElement,
		text: string,
		signal: AbortSignal,
	): Promise<void> {
		const target = await this.bind(signal);
		await this.driver.call(
			"browser_type",
			{
				target_id: target.target_id,
				tab_id: target.tab_id,
				ref: element.handle,
				text,
				// Replace, not append: the field may hold an earlier attempt.
				replace: true,
				session: this.session,
			},
			signal,
		);
		this.lastTyped = { role: element.role, label: element.label };
	}

	async key(key: JevKey, signal: AbortSignal): Promise<void> {
		const target = await this.bind(signal);
		// Return goes through the page, into the field that was typed in. A native
		// key press lands in whatever the window has focused, and in a fresh
		// window that is the address bar: Return there reloaded the page and the
		// search was submitted empty. Refs expire with every snapshot, so the field
		// is looked up again in the latest one.
		const typed = this.lastTyped;
		const field =
			key === "return" && typed
				? this.lastElements.find(
						(element) =>
							element.role === typed.role && element.label === typed.label,
					)
				: undefined;
		if (field) {
			await this.driver.call(
				"browser_type",
				{
					target_id: target.target_id,
					tab_id: target.tab_id,
					ref: field.handle,
					text: "\n",
					mode: "keystrokes",
					session: this.session,
				},
				signal,
			);
			return;
		}
		// The browser process owns several windows, so the key names its own.
		await this.driver.call(
			"press_key",
			{
				pid: target.pid,
				window_id: target.window_id,
				key,
				session: this.session,
			},
			signal,
		);
	}

	async scroll(direction: "up" | "down", signal: AbortSignal): Promise<void> {
		const target = await this.bind(signal);
		await this.driver.call(
			"browser_pointer",
			{
				target_id: target.target_id,
				tab_id: target.tab_id,
				action: "scroll",
				...(this.scrollRef
					? { ref: this.scrollRef, input_route: "dom_event" }
					: {}),
				delta_x: 0,
				delta_y: direction === "down" ? SCROLL_PX : -SCROLL_PX,
				session: this.session,
			},
			signal,
		);
	}

	async openUrl(url: string, signal: AbortSignal): Promise<void> {
		const target = await this.bind(signal);
		await this.driver.call(
			"browser_navigate",
			{
				target_id: target.target_id,
				tab_id: target.tab_id,
				url,
				session: this.session,
			},
			signal,
		);
	}

	/** Exact browser-window evidence for the caller; never sent to Jev. */
	async capture(path: string, signal: AbortSignal) {
		const target = await this.bind(signal);
		const captured = await this.driver.call<{ window_title?: string }>(
			"get_window_state",
			{
				pid: target.pid,
				window_id: target.window_id,
				include_accessibility_tree: false,
				include_screenshot: true,
				screenshot_out_file: path,
				max_dimension: 1600,
			},
			signal,
		);
		return {
			screenshotPath: path,
			appName: this.appName,
			windowTitle: captured.window_title ?? this.title,
			coordinateSpace: "window" as const,
			...ImageContent.fromBytes(await Bun.file(path).bytes(), "image/png"),
		};
	}

	/** Closes the driver connection, which also closes the browser it launched. */
	async dispose(): Promise<void> {
		this.target = null;
		await this.driver.close();
	}

	get pageTitle(): string {
		return this.title;
	}

	/** Launches the isolated browser once and binds to its active tab. */
	private async bind(signal: AbortSignal) {
		if (this.target) return this.target;
		// Passing the requested browser's PID makes Driver isolate that executable.
		// Omitting it selects Chrome/Edge regardless of the user's request.
		let requestedPid: number | undefined;
		if (!/^browser$/i.test(this.appName)) {
			const name = canonicalAppName(this.appName);
			const launched = await this.driver.call<{ pid: number }>(
				"launch_app",
				{ name },
				signal,
			);
			requestedPid = launched.pid;
			if (!Number.isInteger(requestedPid) || requestedPid <= 0)
				throw new Error(`Could not launch ${this.appName}.`);
		}
		const profile = agentProfileName(this.appName);
		markProfileExitedCleanly(profile);
		const prepared = await this.driver.call<{ prepared_pid?: number }>(
			"browser_prepare",
			{
				allow_launch: true,
				...(requestedPid ? { pid: requestedPid } : {}),
				profile: { mode: "isolated_named", name: profile },
				session: this.session,
			},
			signal,
		);
		const pid = Number(prepared.prepared_pid);
		if (!Number.isFinite(pid)) {
			throw new Error("The clean browser did not report a process id.");
		}
		// The window appears before its DevTools target can be correlated, and a
		// small splash window appears before the real one: take the largest
		// on-screen window and keep asking until the driver can bind it.
		for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
			if (signal.aborted) throw new Error("aborted");
			const { windows = [] } = await this.driver.call<{
				windows?: DriverWindow[];
			}>("list_windows", { pid }, signal);
			const area = (window: DriverWindow) =>
				(window.bounds?.width ?? 0) * (window.bounds?.height ?? 0);
			const window = windows
				.filter((item) => item.pid === pid && item.is_on_screen)
				.sort((a, b) => area(b) - area(a))[0];
			if (window) {
				const bound = await this.driver.tryCall<{
					target_id?: string;
					tabs?: Array<{ tab_id: string; active?: boolean }>;
				}>(
					"get_browser_state",
					{ pid, window_id: window.window_id, session: this.session },
					signal,
				);
				const tab =
					bound.data.tabs?.find((item) => item.active) ?? bound.data.tabs?.[0];
				if (bound.ok && bound.data.target_id && tab) {
					this.target = {
						pid,
						window_id: window.window_id,
						target_id: bound.data.target_id,
						tab_id: tab.tab_id,
					};
					await showAgentCursor(this.driver, signal);
					return this.target;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, BIND_WAIT_MS));
		}
		throw new Error("The clean browser window did not become ready.");
	}
}

/**
 * Visible controls first, then near the viewport, then offscreen. A link's
 * image and caption are offered as separate refs with the same name; they are
 * the same destination, and offered three times they split Jev's probability,
 * so a non-control ref yields to a real control with its name.
 */
export function elementsFromRefs(refs: readonly PageRef[]): JevElement[] {
	const usable = refs.filter(
		(ref) => ref.ref && ref.role && (ref.actions?.length ?? 0) > 0,
	);
	const controlNames = new Set(
		usable
			.filter((ref) => CONTROL_ROLES.test(ref.role ?? ""))
			.map((ref) => ref.name?.trim())
			.filter(Boolean),
	);
	return usable
		.filter((ref) => {
			if (ref.role === "canvas") return ref.visibility === "in_viewport";
			if (CONTROL_ROLES.test(ref.role ?? "")) return true;
			const name = ref.name?.trim();
			return !!name && !controlNames.has(name);
		})
		.map((ref, order) => ({ ref, order }))
		.sort(
			(a, b) =>
				(VISIBILITY_RANK[a.ref.visibility ?? ""] ?? 3) -
					(VISIBILITY_RANK[b.ref.visibility ?? ""] ?? 3) || a.order - b.order,
		)
		.map(({ ref }) => {
			const states = ref.states ?? {};
			const checked = states.checked ?? states.pressed;
			return {
				handle: ref.ref as string,
				role: ref.role as string,
				label:
					ref.name || (ref.role === "canvas" ? "Drawing canvas" : undefined),
				value:
					typeof checked === "boolean"
						? checked
							? "on"
							: "off"
						: (ref.value ?? undefined),
				selected: states.selected === true,
				// The driver says outright what can be typed into; no role guessing.
				editable: ref.actions?.includes("type") ?? false,
			};
		});
}

/** The quoted text of an outline (`- heading "Example Domain"`), line by line. */
function outlineText(outline: string): string[] {
	return [...outline.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
		(match) => match[1] ?? "",
	);
}

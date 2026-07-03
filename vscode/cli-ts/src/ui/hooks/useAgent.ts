import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { AgentController } from "../../core/agent/AgentController.ts";
import type { EventBus } from "../../core/bus/EventBus.ts";
import type { AgentEvent } from "../../core/bus/events.ts";
import { type AppState, initialState } from "../../state/AppState.ts";
import { reduce } from "../../state/Store.ts";
import { shortId } from "../../utils/id.ts";

export interface UseAgent {
	state: AppState;
	submit: (text: string) => void;
	cancel: () => void;
	cancelCurrent: () => void;
	provideInput: (id: string, answer: string) => void;
	setModelLabel: (label: string) => void;
	clear: () => void;
	newThread: () => void;
	notice: (text: string, level?: "info" | "error") => void;
}

type Action =
	| { type: "event"; event: AgentEvent }
	| { type: "model"; label: string }
	| { type: "clear" }
	| { type: "notice"; text: string; level: "info" | "error" };

function rootReducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "model":
			return { ...state, model: action.label };
		case "clear":
			return {
				...state,
				transcript: [],
				todos: [],
				usage: {},
				render: {
					staticItems: [],
					liveItems: [],
					assistantStreams: [],
					generation: state.render.generation + 1,
				},
			};
		case "notice": {
			const item = {
				kind: "notice" as const,
				id: shortId("n"),
				level: action.level,
				text: action.text,
			};
			return {
				...state,
				transcript: [...state.transcript, item],
				render: {
					...state.render,
					staticItems: [...state.render.staticItems, item],
				},
			};
		}
		case "event":
			return reduce(state, action.event);
	}
}

/**
 * Binds an AgentController + EventBus to React state. The reducer is the only
 * place bus events mutate UI state, keeping components purely declarative.
 */
export function useAgent(
	controller: AgentController,
	bus: EventBus,
	model: string,
	startupWarnings: readonly string[] = [],
): UseAgent {
	const store = useMemo(
		() => new AgentViewStore(bus, model, startupWarnings),
		[bus, model, startupWarnings],
	);
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);

	const submit = useCallback(
		(text: string) => {
			void controller.submit(text).catch(() => {
				// Errors are already surfaced as run:error events; nothing to do here.
			});
		},
		[controller],
	);

	const cancel = useCallback(
		() => controller.cancel({ clearQueue: true }),
		[controller],
	);
	const cancelCurrent = useCallback(() => controller.cancel(), [controller]);
	const provideInput = useCallback(
		(id: string, answer: string) => controller.provideInput(id, answer),
		[controller],
	);
	const setModelLabel = useCallback(
		(label: string) => store.dispatch({ type: "model", label }),
		[store],
	);
	const clear = useCallback(() => store.dispatch({ type: "clear" }), [store]);
	const newThread = useCallback(() => {
		controller.newThread();
		store.dispatch({ type: "clear" });
	}, [controller, store]);
	const notice = useCallback(
		(text: string, level: "info" | "error" = "info") =>
			store.dispatch({ type: "notice", text, level }),
		[store],
	);

	return {
		state,
		submit,
		cancel,
		cancelCurrent,
		provideInput,
		setModelLabel,
		clear,
		newThread,
		notice,
	};
}

type StoreListener = () => void;

class AgentViewStore {
	private state: AppState;
	private readonly listeners = new Set<StoreListener>();
	private unsubscribeBus: (() => void) | null = null;

	constructor(
		private readonly bus: EventBus,
		model: string,
		startupWarnings: readonly string[],
	) {
		const warnings = startupWarnings.map((text) => ({
			kind: "notice" as const,
			id: shortId("n"),
			level: "info" as const,
			text,
		}));
		this.state = {
			...initialState(model),
			transcript: warnings,
			render: {
				staticItems: warnings,
				liveItems: [],
				assistantStreams: [],
				generation: 0,
			},
		};
	}

	readonly getSnapshot = (): AppState => this.state;

	readonly subscribe = (listener: StoreListener): (() => void) => {
		this.listeners.add(listener);
		if (this.listeners.size === 1) {
			this.unsubscribeBus = this.bus.onAny((event) => {
				this.dispatch({ type: "event", event });
			});
		}

		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.unsubscribeBus?.();
				this.unsubscribeBus = null;
			}
		};
	};

	dispatch(action: Action): void {
		const next = rootReducer(this.state, action);
		if (next === this.state) return;
		this.state = next;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

import type { EventBus } from "../bus/EventBus.ts";
import type { TodoItem, TurnStatus, UsageInfo } from "../bus/events.ts";
import { areTodosComplete } from "../todos/TodoList.ts";
import type { Message } from "./Message.ts";

/**
 * In-memory projection of a run. Holds the Backboard thread id, the message
 * transcript, accumulated usage, todos, and the current turn status. This is
 * the authoritative runtime state; the on-disk logs are the durable record.
 */
export class Session {
	threadId: string | null = null;
	assistantId: string | null = null;
	status: TurnStatus = "completed";

	private readonly messages: Message[] = [];
	private todoList: TodoItem[] = [];
	private usageTotals: Required<
		Pick<UsageInfo, "inputTokens" | "outputTokens" | "totalTokens">
	> = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};

	constructor(readonly sessionId: string) {}

	addMessage(message: Message): void {
		this.messages.push(message);
	}

	/** Starts a fresh thread: drops the transcript, thread id, todos, and usage. */
	reset(): void {
		this.threadId = null;
		this.status = "completed";
		this.messages.length = 0;
		this.todoList = [];
		this.usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	}

	getMessages(): readonly Message[] {
		return this.messages;
	}

	setTodos(todos: readonly TodoItem[]): void {
		this.todoList = [...todos];
	}

	get todos(): readonly TodoItem[] {
		return this.todoList;
	}

	attach(bus: EventBus): () => void {
		const unsubscribeTodos = bus.on("todos:updated", (event) => {
			this.setTodos(event.todos);
		});
		const unsubscribeTurnStart = bus.on("turn:start", () => {
			if (areTodosComplete(this.todoList)) this.todoList = [];
		});
		return () => {
			unsubscribeTodos();
			unsubscribeTurnStart();
		};
	}

	addUsage(usage: UsageInfo): void {
		this.usageTotals.inputTokens += usage.inputTokens ?? 0;
		this.usageTotals.outputTokens += usage.outputTokens ?? 0;
		this.usageTotals.totalTokens += usage.totalTokens ?? 0;
	}

	get usage(): Readonly<typeof this.usageTotals> {
		return this.usageTotals;
	}
}

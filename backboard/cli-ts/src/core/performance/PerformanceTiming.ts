import type { EventBus } from "../bus/EventBus.ts";
import type { PerformanceTimingPhase } from "../bus/events.ts";

export interface PerformanceTimingDetails {
	toolCallId?: string;
	workerId?: string;
	fileCount?: number;
}

export function emitPerformanceTiming(
	bus: EventBus | undefined,
	phase: PerformanceTimingPhase,
	startedAt: number,
	details: PerformanceTimingDetails = {},
): void {
	if (!bus) return;
	bus.emit({
		type: "performance:timing",
		phase,
		durationMs: Math.max(0, performance.now() - startedAt),
		...details,
	});
}

export async function measurePerformance<T>(
	bus: EventBus | undefined,
	phase: PerformanceTimingPhase,
	details: PerformanceTimingDetails,
	run: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	try {
		return await run();
	} finally {
		emitPerformanceTiming(bus, phase, startedAt, details);
	}
}

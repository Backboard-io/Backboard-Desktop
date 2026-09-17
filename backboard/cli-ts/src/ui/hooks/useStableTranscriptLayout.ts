import { useRef } from "react";
import type { RenderTranscriptItem } from "../../state/AppState.ts";
import { splitResponsiveTranscript } from "../components/TranscriptLayout.ts";
import type { TranscriptLayout } from "../components/TranscriptLayout.types.ts";

interface LayoutCache {
	items: RenderTranscriptItem[];
	tailItemCount: number | undefined;
	generation: number | undefined;
	/** The minimumStaticItemCount value the cached layout was computed with. */
	minUsed: number;
	layout: TranscriptLayout;
}

export function useStableTranscriptLayout(
	items: RenderTranscriptItem[],
	tailItemCount?: number,
	generation?: number,
): TranscriptLayout {
	const staticItemCount = useRef(0);
	const generationRef = useRef(generation);
	if (generationRef.current !== generation) {
		generationRef.current = generation;
		staticItemCount.current = 0;
	}
	// The split is a pure function of these inputs, and App re-renders on every
	// bus event. Caching by identity keeps `staticItems`/`responsiveItems`
	// referentially stable across delta-only frames so the memoized transcript
	// components can skip re-rendering instead of re-slicing per frame.
	// `staticItemCount.current` only changes when a new layout is computed, so
	// comparing it against the value used for the cache keeps hits stable.
	const cache = useRef<LayoutCache | null>(null);
	const cached = cache.current;
	if (
		cached !== null &&
		cached.items === items &&
		cached.tailItemCount === tailItemCount &&
		cached.generation === generation &&
		cached.minUsed === staticItemCount.current
	) {
		return cached.layout;
	}
	const minimumStaticItemCount = Math.min(
		staticItemCount.current,
		items.length,
	);
	const layout = splitResponsiveTranscript(
		items,
		tailItemCount,
		minimumStaticItemCount,
	);
	staticItemCount.current = layout.staticItems.length;
	cache.current = {
		items,
		tailItemCount,
		generation,
		minUsed: staticItemCount.current,
		layout,
	};
	return layout;
}

import { useRef } from "react";
import type { RenderTranscriptItem } from "../../state/AppState.ts";
import { splitResponsiveTranscript } from "../components/TranscriptLayout.ts";
import type { TranscriptLayout } from "../components/TranscriptLayout.types.ts";

export function useStableTranscriptLayout(
	items: RenderTranscriptItem[],
	tailItemCount?: number,
): TranscriptLayout {
	const staticItemCount = useRef(0);
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
	return layout;
}

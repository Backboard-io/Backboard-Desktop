import { Static } from "ink";
import type React from "react";
import type { UsageInfo } from "../../core/bus/events.ts";
import type { RenderTranscriptItem, RunStatus } from "../../state/AppState.ts";
import { Banner } from "./Banner.tsx";
import { Item } from "./MessageList.tsx";

interface Props {
	items: RenderTranscriptItem[];
	generation: number;
	banner: {
		status: RunStatus;
		model: string;
		cwd: string;
		usage: UsageInfo;
	} | null;
}

type StaticTranscriptItem =
	| RenderTranscriptItem
	| {
			kind: "banner";
			id: string;
			status: RunStatus;
			model: string;
			cwd: string;
			usage: UsageInfo;
	  };

export function StaticTranscript({
	items,
	generation,
	banner,
}: Props): React.ReactElement {
	// Items arrive pre-grouped from the store; do NOT regroup here - <Static>
	// is append-only and rewriting already-printed entries drops them.
	const staticItems: StaticTranscriptItem[] = banner
		? [
				{
					kind: "banner",
					id: "banner",
					status: banner.status,
					model: banner.model,
					cwd: banner.cwd,
					usage: banner.usage,
				},
				...items,
			]
		: items;

	return (
		<Static key={generation} items={staticItems}>
			{(item) =>
				item.kind === "banner" ? (
					<Banner
						key={item.id}
						status={item.status}
						model={item.model}
						cwd={item.cwd}
						usage={item.usage}
					/>
				) : (
					<Item key={item.id} item={item} />
				)
			}
		</Static>
	);
}

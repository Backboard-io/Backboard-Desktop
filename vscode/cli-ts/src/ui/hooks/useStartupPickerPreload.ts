import { useEffect } from "react";
import type { SkillController } from "../../core/skills/SkillController.ts";
import type { BackboardClient } from "../../providers/backboard/BackboardClient.ts";
import { fetchModels } from "../../providers/backboard/models.ts";

const PICKER_PRELOAD_REFRESH_MS = 5 * 60 * 1000;

export function useStartupPickerPreload(
	client: BackboardClient,
	skillController: SkillController,
): void {
	useEffect(() => {
		preloadPickers(client, skillController);
		const timer = setInterval(
			() => preloadPickers(client, skillController),
			PICKER_PRELOAD_REFRESH_MS,
		);
		return () => clearInterval(timer);
	}, [client, skillController]);
}

function preloadPickers(
	client: BackboardClient,
	skillController: SkillController,
): void {
	void fetchModels(client).catch(() => undefined);
	void skillController.preloadSkillTabs();
}

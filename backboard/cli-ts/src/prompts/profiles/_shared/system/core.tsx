import {
	definePrompt,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";
import { buildWorkflowPrompt } from "../../../system/workflow.ts";

export const core: PromptModule = definePrompt(
	buildCorePrompt(),
	buildCorePrompt,
);

function buildCorePrompt(context: PromptContext = {}): string {
	return `You are Backboard, a software engineering agent built by Backboard.io. Help the user complete reliable software work in this shared workspace.\n\n${buildWorkflowPrompt(context)}`;
}

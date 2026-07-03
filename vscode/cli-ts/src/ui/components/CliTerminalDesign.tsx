import { Box } from "ink";
import type React from "react";
import { CliPromptInput } from "./CliPromptInput.tsx";
import { CliToolCall } from "./CliToolCall.tsx";
import { CommandLine } from "./CommandLine.tsx";
import { ErrorBanner } from "./ErrorBanner.tsx";
import { ResponseBlock } from "./ResponseBlock.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { ShellPrompt } from "./ShellPrompt.tsx";
import { TerminalBody } from "./TerminalBody.tsx";
import type { CliTerminalDesignProps } from "./TerminalComponents.types.ts";
import { TerminalFrame } from "./TerminalFrame.tsx";

export function CliTerminalDesign({
	screen = "empty",
	model,
	cwd,
}: CliTerminalDesignProps): React.ReactElement {
	const running = screen === "loading";
	const error = screen === "error";
	return (
		<TerminalFrame
			status={error ? "error" : running ? "thinking" : "ready"}
			model={model}
			cwd={cwd}
		>
			<Box flexDirection="column">
				<Box paddingX={1}>
					<ShellPrompt state={screen === "empty" ? "default" : "active"} />
				</Box>
				{screen === "empty" ? null : (
					<Box paddingX={1}>
						<CommandLine value="backboard" state="submitted" />
					</Box>
				)}
				<Box paddingX={1}>
					<SessionCard />
				</Box>
				<Box paddingX={1}>
					<CliPromptInput
						value="Explain this codebase"
						state={running || error ? "submitted" : "active"}
					/>
				</Box>
				{screen === "default" || error ? (
					<Box flexDirection="column" marginTop={1}>
						<ResponseBlock />
						<CliToolCall
							name="framer.readCodeFile"
							inputSummary={'framer.readCodeFile({"codeFileId":"LKMdp9t"})'}
							state="expanded"
						/>
					</Box>
				) : null}
				{running ? <TerminalBody state="loading" /> : null}
				{error ? (
					<ErrorBanner message="Conversation interrupted - tell the model what to do differently. Something went wrong? Hit /feedback to report the issue." />
				) : null}
			</Box>
		</TerminalFrame>
	);
}

import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { BackboardMascot } from "./BackboardMascot.tsx";
import type {
	AuthPromptProps,
	AuthPromptSelection,
} from "./TerminalComponents.types.ts";

const ACTIONS: Record<AuthPromptSelection, string> = {
	login: "Login / Signup",
	exit: "Exit",
};

export function AuthPrompt({
	selected = "login",
}: AuthPromptProps): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Box
				borderStyle="round"
				borderColor={theme.accentBright}
				paddingX={2}
				paddingY={1}
			>
				<Box flexDirection="column" justifyContent="center" marginRight={4}>
					<BackboardMascot />
				</Box>
				<Box flexDirection="column">
					<Text color={theme.text} bold>
						Backboard CLI is ready
					</Text>
					<Text color={theme.subtle}>
						Login or signup to use Backboard CLI.
					</Text>
					<Text color={theme.warning}>Status: Not Connected</Text>
				</Box>
			</Box>
			<Box flexDirection="column" marginTop={1} paddingX={1}>
				<Text color={theme.accentBright}>
					Please login or signup with your Backboard account to continue.
				</Text>
				<Box flexDirection="column" marginTop={1}>
					{Object.entries(ACTIONS).map(([key, label]) => {
						const active = key === selected;
						return (
							<Box key={key}>
								<Text color={active ? theme.accentBright : theme.subtle}>
									{active ? "› " : "  "}
								</Text>
								<Text
									color={active ? theme.accentBright : theme.subtle}
									bold={active}
								>
									{label}
								</Text>
							</Box>
						);
					})}
				</Box>
			</Box>
		</Box>
	);
}

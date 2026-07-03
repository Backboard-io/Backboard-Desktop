import { Box, Text } from "ink";
import type React from "react";
import { Spinner } from "./Spinner.tsx";
import type { TerminalBodyProps } from "./TerminalComponents.types.ts";

export function TerminalBody({
	state = "empty",
	children,
}: TerminalBodyProps): React.ReactElement {
	if (state === "loading") {
		return (
			<Box padding={1}>
				<Spinner label="Thinking" />
			</Box>
		);
	}

	if (state === "content") {
		return (
			<Box flexDirection="column" padding={1}>
				{children}
			</Box>
		);
	}

	return (
		<Box padding={1}>
			<Text> </Text>
		</Box>
	);
}

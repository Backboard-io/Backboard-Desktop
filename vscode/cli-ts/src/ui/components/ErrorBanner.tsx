import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import type {
	ErrorBannerProps,
	ErrorBannerType,
} from "./TerminalComponents.types.ts";

const COLOR: Record<ErrorBannerType, string> = {
	error: theme.error,
	warning: theme.warning,
};

export function ErrorBanner({
	message,
	type = "error",
}: ErrorBannerProps): React.ReactElement {
	return (
		<Box paddingX={1}>
			<Text color={COLOR[type]}>■ </Text>
			<Text color={COLOR[type]}>{message}</Text>
		</Box>
	);
}

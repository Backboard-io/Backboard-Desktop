import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type {
	AuthAction,
	AuthScreenMode,
	AuthScreenProps,
} from "./AuthScreenTypes.ts";
import { AuthPrompt } from "./components/AuthPrompt.tsx";
import { Spinner } from "./components/Spinner.tsx";
import { theme } from "./theme/theme.ts";

const AUTH_ACTIONS: readonly AuthAction[] = ["login", "exit"];

export function AuthScreen({ onLogin }: AuthScreenProps): React.ReactElement {
	const app = useApp();
	const [mode, setMode] = useState<AuthScreenMode>("select");
	const [selected, setSelected] = useState<AuthAction>("login");
	const [deviceCode, setDeviceCode] = useState<{
		userCode: string;
		verificationUri: string;
		verificationUriComplete: string;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);

	const submitSelected = (): void => {
		if (mode === "loading") {
			return;
		}
		if (selected === "exit") {
			app.exit();
			return;
		}

		setError(null);
		setDeviceCode(null);
		setMode("loading");
		void onLogin((response) => {
			setDeviceCode({
				userCode: response.user_code,
				verificationUri: response.verification_uri,
				verificationUriComplete: response.verification_uri_complete,
			});
		})
			.then(() => app.exit())
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err));
				setMode("select");
			});
	};

	useInput((_input, key) => {
		if (mode === "loading") {
			return;
		}
		if (key.escape) {
			app.exit();
			return;
		}
		if (key.upArrow || key.downArrow) {
			setSelected((current) => nextAction(current));
			return;
		}
		if (key.return) {
			submitSelected();
		}
	});

	if (mode === "loading") {
		return (
			<Box flexDirection="column">
				<AuthPrompt selected={selected} />
				<Box marginTop={1} paddingX={1}>
					<Spinner label="Waiting for approval" />
				</Box>
				{deviceCode ? (
					<Box marginTop={1} flexDirection="column" paddingX={1}>
						<Text color={theme.subtle}>
							Open this URL on any device with a browser (code already filled
							in):
						</Text>
						<Text>{deviceCode.verificationUriComplete}</Text>
						<Text color={theme.subtle}>
							Or go to {deviceCode.verificationUri} and enter code:
						</Text>
						<Text bold>{deviceCode.userCode}</Text>
					</Box>
				) : null}
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<AuthPrompt selected={selected} />
			{error ? <Text color={theme.error}>{error}</Text> : null}
		</Box>
	);
}

function nextAction(current: AuthAction): AuthAction {
	const index = AUTH_ACTIONS.indexOf(current);
	return AUTH_ACTIONS[(index + 1) % AUTH_ACTIONS.length] ?? "login";
}

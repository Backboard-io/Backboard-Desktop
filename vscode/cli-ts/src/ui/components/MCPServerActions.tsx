import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { McpServerRuntimeStatus } from "../../core/mcp/index.ts";
import { theme } from "../theme/theme.ts";
import { Spinner } from "./Spinner.tsx";

interface Props {
	server: McpServerRuntimeStatus;
	onAuthenticate: (
		server: McpServerRuntimeStatus,
		signal: AbortSignal,
	) => Promise<void> | void;
	onDisable: (
		server: McpServerRuntimeStatus,
		signal: AbortSignal,
	) => Promise<void> | void;
	onRemove: (
		server: McpServerRuntimeStatus,
		signal: AbortSignal,
	) => Promise<void> | void;
	onBrowse: (server: McpServerRuntimeStatus, signal: AbortSignal) => void;
	onCancel: () => void;
}

type ActionId = "browse" | "authenticate" | "disable" | "remove";

interface ServerAction {
	id: ActionId;
	label: string;
	enabled: boolean;
	disabledReason?: string;
}

export function McpServerActions({
	server,
	onAuthenticate,
	onDisable,
	onRemove,
	onBrowse,
	onCancel,
}: Props): React.ReactElement {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [submitting, setSubmitting] = useState(false);
	const [submittingLabel, setSubmittingLabel] = useState("Updating MCP server");
	const [abortController, setAbortController] =
		useState<AbortController | null>(null);
	const [error, setError] = useState<string | null>(null);
	const actions = serverActions(server);
	const safeSelectedIndex = Math.min(
		selectedIndex,
		Math.max(0, actions.length - 1),
	);

	const runAction = (
		label: string,
		action: (signal: AbortSignal) => Promise<void> | void,
	): void => {
		const controller = new AbortController();
		setSubmittingLabel(label);
		setSubmitting(true);
		setAbortController(controller);
		setError(null);
		Promise.resolve(action(controller.signal))
			.catch((err) => {
				if (controller.signal.aborted) return;
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				setAbortController((current) =>
					current === controller ? null : current,
				);
				setSubmitting(false);
			});
	};

	const runSelectedAction = (): void => {
		const action = actions[safeSelectedIndex];
		if (!action) return;
		if (!action.enabled) {
			setError(action.disabledReason ?? `${action.label} is unavailable.`);
			return;
		}
		if (action.id === "browse") {
			runAction("Loading MCP prompts and resources", (signal) =>
				onBrowse(server, signal),
			);
			return;
		}
		if (action.id === "authenticate") {
			runAction("Authenticating MCP server", (signal) =>
				onAuthenticate(server, signal),
			);
			return;
		}
		if (action.id === "disable") {
			runAction("Disabling MCP server", (signal) => onDisable(server, signal));
			return;
		}
		if (action.id === "remove") {
			runAction("Removing MCP server", (signal) => onRemove(server, signal));
		}
	};

	useInput((input, key) => {
		if (submitting) {
			if (key.escape) abortController?.abort();
			return;
		}
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.upArrow) {
			setSelectedIndex((index) =>
				index <= 0 ? actions.length - 1 : index - 1,
			);
			setError(null);
			return;
		}
		if (key.downArrow) {
			setSelectedIndex((index) =>
				index >= actions.length - 1 ? 0 : index + 1,
			);
			setError(null);
			return;
		}
		if (/^[1-4]$/.test(input)) {
			setSelectedIndex(Number(input) - 1);
			setError(null);
			return;
		}
		if (key.return) {
			runSelectedAction();
		}
	});

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text color={theme.text} bold>
				MCP Server: {server.name}
			</Text>
			<Text>
				<Text color={theme.subtle}>status </Text>
				<Text color={statusColor(server.status)}>
					{statusLabel(server.status)}
				</Text>
			</Text>
			<Text color={theme.subtle}>
				type {server.type.toUpperCase()} · tools {server.toolNames.length}
			</Text>
			{server.message ? (
				<Text color={theme.error}>{server.message}</Text>
			) : null}
			<Text>
				<Text color={theme.subtle}>prompts </Text>
				<Text>{server.promptNames?.length ?? 0}</Text>
				<Text color={theme.subtle}> · resources </Text>
				<Text>{server.resourceUris?.length ?? 0}</Text>
			</Text>
			<Text color={theme.subtle}>
				supported {primitiveSupportLabel(server)} · subscribed{" "}
				{server.subscribedResourceUris?.length ?? 0} · updated{" "}
				{server.updatedResourceUris?.length ?? 0}
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{actions.map((action, index) => {
					const selected = index === safeSelectedIndex;
					const color = action.enabled
						? selected
							? theme.accentBright
							: theme.subtle
						: theme.subtle;
					return (
						<Text
							key={action.id}
							color={color}
							bold={selected && action.enabled}
						>
							{selected ? "› " : "  "}
							{action.label}
						</Text>
					);
				})}
			</Box>
			{error ? <Text color={theme.error}>{error}</Text> : null}
			<Text color={theme.subtle}>
				{submitting
					? "esc cancel action"
					: "↑/↓ choose · 1-4 jump · enter select · esc back"}
			</Text>
			{submitting ? <Spinner label={submittingLabel} /> : null}
		</Box>
	);
}

function serverActions(server: McpServerRuntimeStatus): ServerAction[] {
	const canAuthenticate = canAuthenticateMcpServer(server);
	return [
		{
			id: "browse",
			label: "Browse Prompts & Resources",
			enabled: server.status === "connected",
			disabledReason: `${server.name} is not connected.`,
		},
		{
			id: "authenticate",
			label: server.status === "connected" ? "Re-authenticate" : "Authenticate",
			enabled: canAuthenticate,
			disabledReason:
				server.type !== "http"
					? "Only HTTP MCP servers support browser authentication."
					: `Authentication is not available while ${server.name} is ${statusLabel(server.status)}.`,
		},
		{
			id: "disable",
			label: "Disable",
			enabled: server.status !== "disabled",
			disabledReason: `${server.name} is already disabled.`,
		},
		{
			id: "remove",
			label: "Remove Server",
			enabled: true,
		},
	];
}

export function canAuthenticateMcpServer(
	server: McpServerRuntimeStatus,
): boolean {
	return server.type === "http" && server.status !== "disabled";
}

function statusLabel(status: McpServerRuntimeStatus["status"]): string {
	switch (status) {
		case "connected":
			return "connected";
		case "needs_authentication":
			return "needs authentication";
		case "disabled":
			return "disabled";
		case "error":
			return "error";
	}
}

function statusColor(
	status: McpServerRuntimeStatus["status"],
): string | undefined {
	switch (status) {
		case "connected":
			return theme.success;
		case "needs_authentication":
			return theme.warning;
		case "disabled":
			return theme.subtle;
		case "error":
			return theme.error;
	}
}

function primitiveSupportLabel(server: McpServerRuntimeStatus): string {
	const capabilities = server.capabilities;
	if (!capabilities) return "unknown";
	const labels = [
		capabilities.prompts ? "prompts" : "",
		capabilities.resources ? "resources" : "",
		capabilities.resources?.subscribe ? "subscriptions" : "",
	].filter(Boolean);
	return labels.length > 0 ? labels.join(", ") : "tools only";
}

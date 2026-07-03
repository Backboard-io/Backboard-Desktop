import type React from "react";

export type ShellPromptState = "default" | "active";

export interface ShellPromptProps {
	state?: ShellPromptState;
	user?: string;
	path?: string;
	version?: string;
	time?: string;
}

export interface ShellPromptLayoutInput {
	columns: number;
	user: string;
	path: string;
	version: string;
	time?: string;
}

export interface ShellPromptLayout {
	user?: string;
	path: string;
	version?: string;
	time?: string;
}

export type CommandLineState = "default" | "typing" | "submitted";

export interface CommandLineProps {
	value?: string;
	placeholder?: string;
	state?: CommandLineState;
}

export type PromptInputState = "empty" | "active" | "submitted";

export interface CliPromptInputProps {
	value?: string;
	placeholder?: string;
	state?: PromptInputState;
}

export type TerminalBodyState = "empty" | "loading" | "content";

export interface TerminalBodyProps {
	state?: TerminalBodyState;
	children?: React.ReactNode;
}

export type ErrorBannerType = "error" | "warning";

export interface ErrorBannerProps {
	message: string;
	type?: ErrorBannerType;
}

export interface ResponseBlockProps {
	lines?: readonly string[];
	highlight?: string;
}

export type ToolCallState = "collapsed" | "expanded";

export interface CliToolCallProps {
	name: string;
	inputSummary: string;
	outputPreview?: readonly string[];
	state?: ToolCallState;
}

export type CliStatusFooterState = "ready" | "thinking" | "error";

export interface CliStatusFooterProps {
	status?: CliStatusFooterState;
	model: string;
	cwd: string;
}

export type SessionCardType = "authenticated" | "noAuth";

export interface SessionCardProps {
	type?: SessionCardType;
	workspace?: string;
	status?: string;
	model?: string;
	context?: string;
}

export type AuthPromptSelection = "login" | "exit";

export interface AuthPromptProps {
	selected?: AuthPromptSelection;
}

export type PickerItemState = "default" | "hover" | "error" | "disabled";

export interface SkillSearchProps {
	value?: string;
	state?: PickerItemState;
}

export type SkillItemAction = "add" | "edit" | "delete";

export interface SkillItemProps {
	name: string;
	description: string;
	action?: SkillItemAction;
	state?: PickerItemState;
}

export type CatalogTerminalMode = "empty" | "typed" | "add" | "edit" | "delete";

export interface CatalogTerminalProps {
	title: string;
	search?: string;
	mode?: CatalogTerminalMode;
	items?: readonly SkillItemProps[];
}

export type ModelSelectionMode =
	| "empty"
	| "modelQuery"
	| "providerQuery"
	| "noResults"
	| "submitted";

export interface ModelSelectionTerminalProps {
	mode?: ModelSelectionMode;
	models?: readonly string[];
}

export type CliTerminalScreen = "empty" | "default" | "loading" | "error";

export interface CliTerminalDesignProps {
	screen?: CliTerminalScreen;
	model: string;
	cwd: string;
}

export type TerminalFrameStatus = "ready" | "thinking" | "error";

export interface TerminalFrameProps {
	title?: string;
	status?: TerminalFrameStatus;
	model: string;
	cwd: string;
	children: React.ReactNode;
}

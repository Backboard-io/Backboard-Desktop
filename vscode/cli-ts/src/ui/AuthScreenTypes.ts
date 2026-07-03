import type { BackboardDeviceCodeResponse } from "../core/auth/BackboardOAuth.ts";

export type AuthAction = "login" | "exit";

export type AuthScreenMode = "select" | "loading";

export type AuthDeviceCodeHandler = (
	response: BackboardDeviceCodeResponse,
) => void;

export type AuthLoginHandler = (
	onDeviceCode?: AuthDeviceCodeHandler,
) => Promise<string>;

export interface AuthScreenProps {
	onLogin: AuthLoginHandler;
}

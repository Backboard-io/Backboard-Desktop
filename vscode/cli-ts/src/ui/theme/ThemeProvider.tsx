import type React from "react";
import { createContext, useContext } from "react";
import { defaultTheme, setTheme, type Theme } from "./theme.ts";

const ThemeContext = createContext<Theme>(defaultTheme);

export function ThemeProvider({
	children,
	value,
}: {
	children: React.ReactNode;
	value: Theme;
}): React.ReactElement {
	setTheme(value);
	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): Theme {
	return useContext(ThemeContext);
}

import { useEffect, useState } from "react";
import {
	applyTheme,
	initialThemePreference,
	readStoredTheme,
	resolveTheme,
	systemPrefersDark,
	THEME_STORAGE_KEY,
	type ThemePreference
} from "./theme";

export function useTheme(defaultTheme: ThemePreference) {
	const [preference, setThemePreference] = useState(() =>
		initialThemePreference(readStoredTheme(), defaultTheme)
	);
	const [systemDark, setSystemDark] = useState(systemPrefersDark);
	const resolved = resolveTheme(preference, systemDark);

	useEffect(() => {
		if (!readStoredTheme()) setThemePreference(defaultTheme);
	}, [defaultTheme]);

	useEffect(() => {
		if (preference !== "system" || typeof window === "undefined" || !window.matchMedia) return;
		try {
			const query = window.matchMedia("(prefers-color-scheme: dark)");
			setSystemDark(query.matches);
			const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
			if (query.addEventListener) {
				query.addEventListener("change", update);
				return () => query.removeEventListener("change", update);
			}
			query.addListener(update);
			return () => query.removeListener(update);
		} catch {
			setSystemDark(false);
		}
	}, [preference]);

	useEffect(() => applyTheme(resolved), [resolved]);

	function setPreference(value: ThemePreference) {
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, value);
		} catch {
			// The control still works when browser storage is unavailable.
		}
		setThemePreference(value);
	}

	return { preference, resolved, setPreference };
}

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "status-theme";

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}

export function readStoredTheme(storage?: Pick<Storage, "getItem">): ThemePreference | undefined {
	try {
		const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
		const value = source?.getItem(THEME_STORAGE_KEY);
		return isThemePreference(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
	return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function systemPrefersDark(matchMedia?: (query: string) => { matches: boolean }): boolean {
	try {
		const query =
			matchMedia ?? (typeof window === "undefined" ? undefined : window.matchMedia?.bind(window));
		return query?.("(prefers-color-scheme: dark)").matches ?? false;
	} catch {
		return false;
	}
}

export function initialThemePreference(
	stored: ThemePreference | undefined,
	defaultTheme: ThemePreference
): ThemePreference {
	return stored ?? defaultTheme;
}

export function applyTheme(
	theme: ResolvedTheme,
	root?: { dataset: Record<string, string | undefined> }
): void {
	const target = root ?? (typeof document === "undefined" ? undefined : document.documentElement);
	if (target) target.dataset.theme = theme;
}

export function selectLogo(
	publicConfig: { logo: string; logoDark: string },
	theme: ResolvedTheme
): { src: string; plate: boolean } {
	if (!publicConfig.logo) return { src: "", plate: false };
	if (theme === "dark" && publicConfig.logoDark)
		return { src: publicConfig.logoDark, plate: false };
	return { src: publicConfig.logo, plate: theme === "dark" };
}

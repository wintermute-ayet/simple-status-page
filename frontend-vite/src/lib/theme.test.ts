import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyTheme,
	initialThemePreference,
	isThemePreference,
	readStoredTheme,
	resolveTheme,
	selectLogo,
	systemPrefersDark,
	THEME_STORAGE_KEY,
	type ThemePreference
} from "./theme";

afterEach(() => vi.unstubAllGlobals());

describe("theme preferences", () => {
	it.each<ThemePreference>(["light", "dark", "system"])(
		"uses the %s default until a choice is stored",
		(value) => {
			expect(initialThemePreference(undefined, value)).toBe(value);
			for (const stored of ["light", "dark", "system"] as const)
				expect(initialThemePreference(stored, value)).toBe(stored);
		}
	);
	it.each([
		["light", false, "light"],
		["light", true, "light"],
		["dark", false, "dark"],
		["dark", true, "dark"],
		["system", false, "light"],
		["system", true, "dark"]
	] as const)("resolves %s with system dark %s to %s", (preference, dark, expected) => {
		expect(resolveTheme(preference, dark)).toBe(expected);
	});
	it("reads only valid choices and tolerates missing or throwing storage", () => {
		vi.stubGlobal("window", undefined);
		expect(readStoredTheme()).toBeUndefined();
		for (const value of [null, "", "invalid", "Dark", "light", "dark", "system"]) {
			const getItem = vi.fn(() => value);
			expect(readStoredTheme({ getItem })).toBe(isThemePreference(value) ? value : undefined);
			expect(getItem).toHaveBeenCalledExactlyOnceWith(THEME_STORAGE_KEY);
		}
		expect(
			readStoredTheme({
				getItem: () => {
					throw new Error("Storage blocked");
				}
			})
		).toBeUndefined();
		vi.stubGlobal("window", {
			get localStorage() {
				throw new Error("Storage blocked");
			}
		});
		expect(readStoredTheme()).toBeUndefined();
	});
	it("safely reads the operating system preference", () => {
		vi.stubGlobal("window", undefined);
		expect(systemPrefersDark()).toBe(false);
		vi.stubGlobal("window", {});
		expect(systemPrefersDark()).toBe(false);
		const query = vi.fn(() => ({ matches: true }));
		expect(systemPrefersDark(query)).toBe(true);
		expect(query).toHaveBeenCalledExactlyOnceWith("(prefers-color-scheme: dark)");
		expect(systemPrefersDark(() => ({ matches: false }))).toBe(false);
		expect(
			systemPrefersDark(() => {
				throw new Error("Unavailable");
			})
		).toBe(false);
	});
	it("applies the resolved theme through the root dataset", () => {
		const root = { dataset: {} as Record<string, string | undefined> };
		applyTheme("dark", root);
		expect(root.dataset).toEqual({ theme: "dark" });
		applyTheme("light", root);
		expect(root.dataset).toEqual({ theme: "light" });
		vi.stubGlobal("document", undefined);
		expect(() => applyTheme("light")).not.toThrow();
	});
});

describe("theme logo selection", () => {
	const config = { logo: "normal SVG", logoDark: "dark SVG" };
	it("uses the normal logo in light mode", () => {
		expect(selectLogo(config, "light")).toEqual({ src: config.logo, plate: false });
	});
	it("uses the dark variant without a plate", () => {
		expect(selectLogo(config, "dark")).toEqual({ src: config.logoDark, plate: false });
	});
	it("puts the normal logo on a light plate when no dark variant exists", () => {
		expect(selectLogo({ ...config, logoDark: "" }, "dark")).toEqual({
			src: config.logo,
			plate: true
		});
	});
	it.each(["light", "dark"] as const)(
		"omits the logo in %s mode when no normal logo is configured",
		(theme) => {
			expect(selectLogo({ logo: "", logoDark: config.logoDark }, theme)).toEqual({
				src: "",
				plate: false
			});
		}
	);
});

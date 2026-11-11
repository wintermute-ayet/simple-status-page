import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/theme-init.js", import.meta.url), "utf8");

function run({
	stored = null,
	defaultTheme = "light",
	systemDark = false,
	storageError = false,
	mediaError = false
}: {
	stored?: string | null;
	defaultTheme?: string;
	systemDark?: boolean;
	storageError?: boolean;
	mediaError?: boolean;
} = {}) {
	const setAttribute = vi.fn();
	const getItem = vi.fn(() => {
		if (storageError) throw new Error("Storage blocked");
		return stored;
	});
	const matchMedia = vi.fn(() => {
		if (mediaError) throw new Error("Media query unavailable");
		return { matches: systemDark };
	});
	runInNewContext(source, {
		document: { documentElement: { getAttribute: () => defaultTheme, setAttribute } },
		localStorage: { getItem },
		window: { matchMedia }
	});
	expect(getItem).toHaveBeenCalledExactlyOnceWith("status-theme");
	expect(setAttribute).toHaveBeenCalledTimes(1);
	return { setAttribute, matchMedia };
}

it("applies stored dark before paint even when the configured default is light", () => {
	expect(run({ stored: "dark" }).setAttribute).toHaveBeenCalledWith("data-theme", "dark");
});
it("resolves the stored system choice using the operating system", () => {
	const result = run({ stored: "system", systemDark: true });
	expect(result.setAttribute).toHaveBeenCalledWith("data-theme", "dark");
	expect(result.matchMedia).toHaveBeenCalledExactlyOnceWith("(prefers-color-scheme: dark)");
	expect(run({ stored: "system" }).setAttribute).toHaveBeenCalledWith("data-theme", "light");
});
it.each([null, "invalid", "Dark", ""])(
	"uses the configured dark default for stored value %s",
	(stored) => {
		expect(run({ stored, defaultTheme: "dark" }).setAttribute).toHaveBeenCalledWith(
			"data-theme",
			"dark"
		);
	}
);
it("resolves a system default and falls back to light for an invalid default", () => {
	expect(run({ defaultTheme: "system", systemDark: true }).setAttribute).toHaveBeenCalledWith(
		"data-theme",
		"dark"
	);
	expect(run({ defaultTheme: "invalid" }).setAttribute).toHaveBeenCalledWith("data-theme", "light");
});
it("defaults to light independently of the operating system", () => {
	expect(run({ systemDark: true }).setAttribute).toHaveBeenCalledWith("data-theme", "light");
});
it("falls back to the configured default when storage throws and to light when matchMedia throws", () => {
	expect(run({ defaultTheme: "dark", storageError: true }).setAttribute).toHaveBeenCalledWith(
		"data-theme",
		"dark"
	);
	expect(
		run({ defaultTheme: "system", storageError: true, systemDark: true }).setAttribute
	).toHaveBeenCalledWith("data-theme", "dark");
	expect(run({ stored: "system", mediaError: true }).setAttribute).toHaveBeenCalledWith(
		"data-theme",
		"light"
	);
	expect(
		run({ defaultTheme: "system", storageError: true, mediaError: true }).setAttribute
	).toHaveBeenCalledWith("data-theme", "light");
});

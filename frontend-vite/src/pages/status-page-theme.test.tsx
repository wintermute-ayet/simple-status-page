// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StatusPage from "./status-page";
import { exampleSnapshot, injectSnapshot } from "../test-support";
import { POLL_INTERVAL_MS } from "../lib/status-poller";

let root: Root;
let container: HTMLDivElement;
let mediaChange: ((event: MediaQueryListEvent) => void) | undefined;
let media: {
	matches: boolean;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 304 })));
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	window.localStorage.clear();
	document.documentElement.removeAttribute("data-theme");
	window.history.replaceState(null, "", "/");
	mediaChange = undefined;
	media = {
		matches: true,
		addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
			mediaChange = listener;
		}),
		removeEventListener: vi.fn()
	};
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => media)
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.getElementById("status-snapshot")?.remove();
	window.localStorage.clear();
	document.documentElement.removeAttribute("data-theme");
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function choose(label: string) {
	const button = [...container.querySelectorAll<HTMLButtonElement>(".theme-toggle button")].find(
		(option) => option.textContent === label
	)!;
	act(() => button.click());
	expect(button.getAttribute("aria-pressed")).toBe("true");
}

it("uses the configured dark logo and switches among Light, Dark and System with persistence", () => {
	const snapshot = exampleSnapshot();
	snapshot.public.defaultTheme = "dark";
	snapshot.public.logoDark = snapshot.public.logo.replace("<svg ", '<svg id="dark-example" ');
	injectSnapshot(snapshot);
	act(() => root.render(createElement(StatusPage)));
	expect(document.documentElement.dataset.theme).toBe("dark");
	expect(container.querySelector(".theme-toggle")?.getAttribute("aria-label")).toBe("Color theme");
	expect(container.querySelector<HTMLImageElement>(".page-header img")?.src).toContain(
		encodeURIComponent(snapshot.public.logoDark)
	);
	expect(container.querySelector(".logo-plate")).toBeNull();
	choose("Light");
	expect(document.documentElement.dataset.theme).toBe("light");
	expect(window.localStorage.getItem("status-theme")).toBe("light");
	expect(container.querySelector<HTMLImageElement>(".page-header img")?.src).toContain(
		encodeURIComponent(snapshot.public.logo)
	);
	choose("Dark");
	expect(document.documentElement.dataset.theme).toBe("dark");
	choose("System");
	expect(document.documentElement.dataset.theme).toBe("dark");
	expect(window.localStorage.getItem("status-theme")).toBe("system");
	expect(container.querySelector("[style]")).toBeNull();
	expect(document.documentElement.hasAttribute("style")).toBe(false);
	expect(fetch).not.toHaveBeenCalled();
});

it("follows system changes only for System and removes the listener when switching away", () => {
	const snapshot = exampleSnapshot();
	snapshot.public.defaultTheme = "system";
	injectSnapshot(snapshot);
	act(() => root.render(createElement(StatusPage)));
	expect(document.documentElement.dataset.theme).toBe("dark");
	expect(container.querySelector(".logo-plate img")).not.toBeNull();
	expect(media.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
	const listener = mediaChange!;
	act(() => listener({ matches: false } as MediaQueryListEvent));
	expect(document.documentElement.dataset.theme).toBe("light");
	choose("Light");
	expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
	expect(document.documentElement.dataset.theme).toBe("light");
});

it("cleans up the system listener on unmount", async () => {
	window.localStorage.setItem("status-theme", "system");
	injectSnapshot();
	act(() => root.render(createElement(StatusPage)));
	const listener = mediaChange!;
	act(() => root.render(null));
	expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
	await act(async () => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2));
	expect(vi.getTimerCount()).toBe(0);
	expect(fetch).not.toHaveBeenCalled();
});

it("supports and cleans up the legacy system media listener", () => {
	const legacy = { matches: true, addListener: vi.fn(), removeListener: vi.fn() };
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => legacy)
	);
	window.localStorage.setItem("status-theme", "system");
	injectSnapshot();
	act(() => root.render(createElement(StatusPage)));
	expect(document.documentElement.dataset.theme).toBe("dark");
	const listener = legacy.addListener.mock.calls[0][0];
	act(() => listener({ matches: false }));
	expect(document.documentElement.dataset.theme).toBe("light");
	choose("Dark");
	expect(legacy.removeListener).toHaveBeenCalledWith(listener);
});

it.each([undefined, "light"] as const)(
	"adopts a changed config default unless a preference is stored (%s)",
	async (stored) => {
		const initial = exampleSnapshot();
		injectSnapshot(initial);
		if (stored) window.localStorage.setItem("status-theme", stored);
		const updated = exampleSnapshot();
		updated.public.defaultTheme = "dark";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(updated)));
		act(() => root.render(createElement(StatusPage)));
		expect(document.documentElement.dataset.theme).toBe("light");
		await act(async () => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));
		expect(document.documentElement.dataset.theme).toBe(stored ?? "dark");
		expect(fetch).toHaveBeenCalledTimes(1);
	}
);

it("keeps the control working when storage is blocked", () => {
	injectSnapshot();
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("Blocked");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("Blocked");
	});
	act(() => root.render(createElement(StatusPage)));
	choose("Dark");
	expect(document.documentElement.dataset.theme).toBe("dark");
});

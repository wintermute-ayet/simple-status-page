// @vitest-environment jsdom
import { Profiler, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StatusPage from "./status-page";
import StatusMonitor from "../components/ui/status-monitor";
import SubscribeDialog from "../components/subscribe-dialog";
import { exampleSnapshot, injectSnapshot } from "../test-support";
import { POLL_INTERVAL_MS } from "../lib/status-poller";
import { averageUptime } from "../lib/history";

let root: Root;
let container: HTMLDivElement;
let hidden = false;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	hidden = false;
	vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
	window.history.replaceState(null, "", "/");
	// jsdom has the dialog element, but not its modal/focus implementation.
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: {
			configurable: true,
			value: function (this: HTMLDialogElement) {
				this.open = true;
			}
		},
		close: {
			configurable: true,
			value: function (this: HTMLDialogElement) {
				this.open = false;
			}
		}
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.getElementById("status-snapshot")?.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function advance(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
function visibility(value: boolean) {
	hidden = value;
	act(() => document.dispatchEvent(new Event("visibilitychange")));
}

it("paints injected status immediately without fetching, then polls once with ETag and skips 304 renders", async () => {
	const snapshot = exampleSnapshot();
	injectSnapshot(snapshot);
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json(snapshot, { headers: { ETag: 'W/"one"' } }))
		.mockResolvedValueOnce(new Response(null, { status: 304 }));
	vi.stubGlobal("fetch", request);
	const renders = vi.fn();
	act(() =>
		root.render(
			createElement(Profiler, { id: "status", onRender: renders }, createElement(StatusPage))
		)
	);
	expect(container.textContent).toContain("Preloaded service");
	expect(container.textContent).toContain("75.0% uptime");
	expect(container.textContent).toContain("Last updated:");
	expect(request).not.toHaveBeenCalled();
	await advance(POLL_INTERVAL_MS);
	expect(request).toHaveBeenCalledTimes(1);
	const renderCount = renders.mock.calls.length;
	await advance(POLL_INTERVAL_MS);
	expect(request).toHaveBeenCalledTimes(2);
	expect(request.mock.calls[1][1]?.headers).toEqual({ "If-None-Match": 'W/"one"' });
	expect(renders).toHaveBeenCalledTimes(renderCount);
	expect(request.mock.calls.every(([url]) => url === "/api/status")).toBe(true);
});

it("uses the injected ETag on its first poll without rendering unchanged data", async () => {
	injectSnapshot(exampleSnapshot(), 'W/"injected"');
	const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 304 }));
	vi.stubGlobal("fetch", request);
	const renders = vi.fn();
	act(() =>
		root.render(
			createElement(Profiler, { id: "status", onRender: renders }, createElement(StatusPage))
		)
	);
	const count = renders.mock.calls.length;
	await advance(POLL_INTERVAL_MS);
	expect(request).toHaveBeenCalledTimes(1);
	expect(request.mock.calls[0][1]?.headers).toEqual({ "If-None-Match": 'W/"injected"' });
	expect(renders).toHaveBeenCalledTimes(count);
});

it.each(["missing", "invalid"])(
	"fetches one complete snapshot when injected data is %s",
	async (kind) => {
		if (kind === "invalid") injectSnapshot().textContent = "{";
		const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(exampleSnapshot()));
		vi.stubGlobal("fetch", request);
		act(() => root.render(createElement(StatusPage)));
		await advance();
		expect(container.textContent).toContain("Preloaded service");
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0]).toBe("/api/status");
	}
);

it("pauses while hidden, shows an unreachable banner while retaining status, and recovers", async () => {
	injectSnapshot();
	const request = vi
		.fn<typeof fetch>()
		.mockRejectedValueOnce(new Error("Offline"))
		.mockResolvedValueOnce(Response.json(exampleSnapshot()));
	vi.stubGlobal("fetch", request);
	act(() => root.render(createElement(StatusPage)));
	visibility(true);
	await advance(POLL_INTERVAL_MS * 3);
	expect(request).not.toHaveBeenCalled();
	visibility(false);
	await advance();
	expect(request).toHaveBeenCalledTimes(1);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("API unreachable");
	expect(container.textContent).toContain("Preloaded service");
	await advance(POLL_INTERVAL_MS);
	expect(request).toHaveBeenCalledTimes(2);
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("explains missing days, excludes them from uptime, and exposes details by keyboard", () => {
	const monitor = exampleSnapshot().monitors[0];
	act(() => root.render(createElement(StatusMonitor, { data: monitor })));
	expect(averageUptime(monitor.history)).toBe(75);
	expect(container.querySelector(".uptime")?.textContent).toBe("75.0% uptime");
	const days = container.querySelectorAll<HTMLButtonElement>(".history-day");
	expect(days[0].getAttribute("aria-label")).toBe("2030-01-01: no data");
	expect(days[1].title).toContain("50.00% uptime, 10.00% degraded");
	expect(container.querySelector(".current-status")?.textContent).toContain("Operational");
	act(() => days[2].focus());
	act(() => days[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
	expect(document.activeElement).toBe(days[0]);
	expect(days[0].tabIndex).toBe(0);
	expect(container.querySelector(".day-details")?.textContent).toBe("2030-01-01: no data");
	act(() =>
		days[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
	);
	expect(document.activeElement).toBe(days[1]);
	expect(container.querySelector(".day-details")?.textContent).toContain("10.00% degraded");
});

it("shows no data for an entirely unknown history rather than zero uptime", () => {
	const monitor = exampleSnapshot().monitors[0];
	monitor.history = monitor.history.slice(0, 1);
	monitor.status = "unknown";
	act(() => root.render(createElement(StatusMonitor, { data: monitor })));
	expect(averageUptime(monitor.history)).toBeNull();
	expect(container.querySelector(".uptime")?.textContent).toBe("No data uptime");
	expect(container.querySelector(".current-status")?.textContent).toContain("Unknown");
	expect(container.textContent).not.toContain("0.0%");
});

it("opens the subscription form with an empty focused field and submits the existing JSON contract", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true }));
	vi.stubGlobal("fetch", request);
	const onClose = vi.fn();
	act(() => root.render(createElement(SubscribeDialog, { onClose })));
	const input = container.querySelector<HTMLInputElement>('input[type="email"]')!;
	expect(input.value).toBe("");
	expect(input.maxLength).toBe(254);
	expect(document.activeElement).toBe(input);
	expect(request).not.toHaveBeenCalled();
	act(() => {
		input.value = ["subscriber", "example.com"].join("@");
		Simulate.change(input);
	});
	await act(async () => Simulate.submit(container.querySelector("form")!));
	expect(request).toHaveBeenCalledTimes(1);
	expect(request.mock.calls[0][0]).toBe("/api/subscribe");
	expect(request.mock.calls[0][1]).toMatchObject({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: input.value })
	});
	expect(container.textContent).toContain("check your inbox");
	act(() =>
		container.querySelector<HTMLButtonElement>('[aria-label="Close subscription form"]')!.click()
	);
	expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the dialog open and announces subscription errors", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }))
	);
	act(() => root.render(createElement(SubscribeDialog, { onClose: vi.fn() })));
	const input = container.querySelector<HTMLInputElement>("input")!;
	act(() => {
		input.value = ["subscriber", "example.com"].join("@");
		Simulate.change(input);
	});
	await act(async () => Simulate.submit(container.querySelector("form")!));
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to subscribe");
	expect(container.querySelector("dialog")?.open).toBe(true);
});

it("reads subscription results from the query string and hides subscription UI when disabled", () => {
	const snapshot = exampleSnapshot();
	snapshot.public.subscriptionsEnabled = false;
	injectSnapshot(snapshot);
	window.history.replaceState(null, "", "/?result=subscribe-success");
	vi.stubGlobal("fetch", vi.fn());
	act(() => root.render(createElement(StatusPage)));
	expect(container.textContent).toContain("Successfully activated your subscription");
	expect(container.querySelector(".page-header button")).toBeNull();
});

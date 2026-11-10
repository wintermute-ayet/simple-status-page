import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS, REQUEST_TIMEOUT_MS, startStatusPolling } from "./status-poller";
import { exampleSnapshot } from "../test-support";

class Visibility extends EventTarget {
	hidden = false;
	change(hidden: boolean) {
		this.hidden = hidden;
		this.dispatchEvent(new Event("visibilitychange"));
	}
}
const snapshot = exampleSnapshot();
let stop: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	stop?.();
	stop = undefined;
	vi.useRealTimers();
});

function setup(initialSnapshot = snapshot, visibility = new Visibility()) {
	const request = vi.fn<typeof fetch>();
	const onSnapshot = vi.fn();
	const onUnreachable = vi.fn();
	return {
		request,
		visibility,
		onSnapshot,
		onUnreachable,
		start: (preload = true, initialEtag?: string) => {
			stop = startStatusPolling({
				initialSnapshot: preload ? initialSnapshot : undefined,
				initialEtag,
				fetch: request,
				visibility,
				onSnapshot,
				onUnreachable
			});
		}
	};
}
function ok(etag = 'W/"version-1"') {
	return Response.json(snapshot, { headers: { ETag: etag } });
}

describe("status polling", () => {
	it("uses injected data without an initial request, then one status request per refresh", async () => {
		const test = setup();
		test.request.mockResolvedValue(ok());
		test.start();
		expect(test.request).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(test.request).toHaveBeenCalledTimes(1);
		expect(test.request.mock.calls[0][0]).toBe("/api/status");
		expect(test.onSnapshot).toHaveBeenCalledWith(snapshot);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(test.request).toHaveBeenCalledTimes(2);
		expect(test.onSnapshot).toHaveBeenCalledTimes(1);
	});
	it("falls back immediately without a snapshot, sends ETag and leaves state untouched on 304", async () => {
		const test = setup();
		const unchanged = new Response(null, { status: 304 });
		const parse = vi.spyOn(unchanged, "json");
		test.request.mockResolvedValueOnce(ok()).mockResolvedValueOnce(unchanged);
		test.start(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(test.request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(test.request.mock.calls[1][1]?.headers).toEqual({ "If-None-Match": 'W/"version-1"' });
		expect(parse).not.toHaveBeenCalled();
		expect(test.onSnapshot).toHaveBeenCalledTimes(1);
		expect(test.onUnreachable).not.toHaveBeenCalled();
	});
	it("pauses in hidden tabs and refreshes once immediately when visible", async () => {
		const test = setup();
		test.request.mockImplementation(async () => ok());
		test.start();
		test.visibility.change(true);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
		expect(test.request).not.toHaveBeenCalled();
		test.visibility.change(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(test.request).toHaveBeenCalledTimes(1);
		test.visibility.change(false);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(test.request).toHaveBeenCalledTimes(2);
		stop!();
		test.visibility.change(true);
		test.visibility.change(false);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(test.request).toHaveBeenCalledTimes(2);
	});
	it("does not even fetch the development fallback until a hidden tab becomes visible", async () => {
		const visibility = new Visibility();
		visibility.hidden = true;
		const test = setup(snapshot, visibility);
		test.request.mockResolvedValue(ok());
		test.start(false);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(test.request).not.toHaveBeenCalled();
		visibility.change(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(test.request).toHaveBeenCalledTimes(1);
	});
	it.each(["network", "http", "json", "shape"])(
		"retains good data on %s failure and recovers",
		async (failure) => {
			const test = setup();
			test.request.mockResolvedValueOnce(ok());
			if (failure === "network") test.request.mockRejectedValueOnce(new Error("Offline"));
			else
				test.request.mockResolvedValueOnce(
					failure === "http"
						? new Response(null, { status: 503 })
						: failure === "json"
							? new Response("{")
							: Response.json({})
				);
			test.request.mockResolvedValueOnce(new Response(null, { status: 304 }));
			test.start(false);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(test.onSnapshot).toHaveBeenCalledTimes(1);
			expect(test.onUnreachable).toHaveBeenLastCalledWith(true);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(test.request.mock.calls[2][1]?.headers).toEqual({ "If-None-Match": 'W/"version-1"' });
			expect(test.onUnreachable).toHaveBeenLastCalledWith(false);
		}
	);
	it("aborts slow requests, prevents overlap, then retries on the normal interval", async () => {
		const test = setup();
		test.request.mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options!.signal!.addEventListener("abort", () => reject(new Error("Aborted")), {
						once: true
					});
				})
		);
		test.start(false);
		await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
		expect(test.onUnreachable).toHaveBeenLastCalledWith(true);
		expect(test.request).toHaveBeenCalledTimes(1);
		test.request.mockResolvedValueOnce(ok());
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(test.request).toHaveBeenCalledTimes(2);
		expect(test.onSnapshot).toHaveBeenCalledTimes(1);
	});
	it("aborts on hiding, resumes without overlapping and ignores results after disposal", async () => {
		const test = setup();
		let resolve!: (response: Response) => void;
		test.request.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		test.start(false);
		const signal = test.request.mock.calls[0][1]?.signal;
		test.visibility.change(true);
		expect(signal?.aborted).toBe(true);
		test.request.mockResolvedValueOnce(ok());
		test.visibility.change(false);
		expect(test.request).toHaveBeenCalledTimes(1);
		resolve(ok());
		await vi.advanceTimersByTimeAsync(0);
		expect(test.request).toHaveBeenCalledTimes(2);
		expect(test.onSnapshot).toHaveBeenCalledTimes(1);
		stop!();
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		expect(test.request).toHaveBeenCalledTimes(2);
	});
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import StatusPage from "../pages/status-page";
import { parseSnapshot, readSnapshot, readSnapshotEtag } from "./status-snapshot";
import { exampleSnapshot } from "../test-support";

afterEach(() => {
	vi.unstubAllGlobals();
});
function inject(json: string) {
	vi.stubGlobal("document", { getElementById: () => ({ textContent: json }) });
}
it("falls back gracefully when the injected data is absent or malformed", () => {
	vi.stubGlobal("document", undefined);
	expect(readSnapshot()).toBeUndefined();
	for (const value of ["", "{", "null", "{}", '{"public":{}}']) {
		inject(value);
		expect(readSnapshot()).toBeUndefined();
	}
});
it("renders its first frame with injected status and history before an API response", () => {
	const snapshot = exampleSnapshot();
	inject(JSON.stringify(snapshot));
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect(readSnapshot()).toEqual(snapshot);
	const html = renderToStaticMarkup(React.createElement(StatusPage));
	expect(html).toContain("Preloaded service");
	expect(html).toContain("Preloaded description");
	expect(html).toContain("Operational");
	expect(html).toContain("75.0%");
	expect(html).toContain("Example");
	expect(fetch).not.toHaveBeenCalled();
});

it("rejects malformed nested data instead of crashing the first render", () => {
	const snapshot = exampleSnapshot();
	for (const value of [
		{ ...snapshot, updatedAt: NaN },
		{ ...snapshot, updatedAt: Number.MAX_VALUE },
		{ ...snapshot, public: { ...snapshot.public, subscriptionsEnabled: "yes" } },
		{ ...snapshot, public: { ...snapshot.public, defaultTheme: "invalid" } },
		{ ...snapshot, public: { ...snapshot.public, defaultTheme: undefined } },
		{ ...snapshot, public: { ...snapshot.public, logoDark: 123 } },
		{ ...snapshot, public: { ...snapshot.public, logoDark: undefined } },
		{ ...snapshot, groups: [{ name: "Invalid", monitors: [99] }] },
		{ ...snapshot, monitors: [null] },
		{ ...snapshot, monitors: [snapshot.monitors[0], snapshot.monitors[0]] },
		{ ...snapshot, monitors: [{ ...snapshot.monitors[0], history: [{ date: "bad" }] }] },
		{ ...snapshot, incidents: [{ message: null }] }
	])
		expect(parseSnapshot(value)).toBeUndefined();
});

it("reads a valid injected ETag and rejects malformed header values", () => {
	for (const value of ['W/"snapshot"', '"strong"', "bad\r\nheader", "unquoted", ""]) {
		vi.stubGlobal("document", { getElementById: () => ({ getAttribute: () => value }) });
		expect(readSnapshotEtag()).toBe(value.includes('"') ? value : undefined);
	}
});

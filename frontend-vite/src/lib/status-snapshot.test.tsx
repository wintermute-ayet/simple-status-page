import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import StatusPage from "../pages/status-page";
import { readSnapshot, type BootstrapSnapshot } from "./status-snapshot";

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
	const snapshot: BootstrapSnapshot = {
		public: {
			companyName: "Example",
			logo: "<svg>✓</svg>",
			favicon: "",
			refreshInterval: 900,
			subscriptionsEnabled: false
		},
		groups: [{ name: "Services", monitors: [1] }],
		incidents: [],
		monitors: [
			{
				id: 1,
				name: "Preloaded service",
				description: "Preloaded description",
				uptimeWording: "uptime",
				status: "up",
				ts: 1,
				history: [{ date: "2030-01-01", status: "down", uptime: 75, degraded: 0 }]
			}
		]
	};
	inject(JSON.stringify(snapshot));
	vi.spyOn(console, "error").mockImplementation(() => {}); // React Router's SSR layout-effect warning.
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect(readSnapshot()).toEqual(snapshot);
	const html = renderToStaticMarkup(
		React.createElement(MemoryRouter, {}, React.createElement(StatusPage))
	);
	expect(html).toContain("Preloaded service");
	expect(html).toContain("Preloaded description");
	expect(html).toContain("Operational");
	expect(html).toContain("75.0%");
	expect(html).toContain("Example");
	expect(fetch).not.toHaveBeenCalled();
});

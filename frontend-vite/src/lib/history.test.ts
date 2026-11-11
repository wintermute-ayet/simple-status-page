import { expect, it } from "vitest";
import { dayDetails } from "./history";
import type { UptimeDay } from "./status-snapshot";

it.each([
	["up", "Operational"],
	["degraded", "Degraded performance"],
	["down", "Down"]
] as const)("omits zero degraded time from %s day details", (status, label) => {
	expect(dayDetails({ date: "2030-01-01", status, uptime: 100, degraded: 0 })).toBe(
		`2030-01-01: ${label}, 100.00% uptime`
	);
});

it("omits unavailable degraded time from a known day", () => {
	expect(dayDetails({ date: "2030-01-01", status: "up", uptime: 99.5, degraded: null })).toBe(
		"2030-01-01: Operational, 99.50% uptime"
	);
});

it.each([0.25, 3.5, 100])(
	"keeps a positive degraded percentage of %s in day details",
	(degraded) => {
		expect(dayDetails({ date: "2030-01-01", status: "degraded", uptime: 100, degraded })).toBe(
			`2030-01-01: Degraded performance, 100.00% uptime, ${degraded.toFixed(2)}% degraded`
		);
	}
);

it.each<UptimeDay>([
	{ date: "2030-01-01", status: "unknown", uptime: null, degraded: null },
	{ date: "2030-01-01", status: "up", uptime: null, degraded: null }
])("names no-data days explicitly ($status)", (day) => {
	expect(dayDetails(day)).toBe("2030-01-01: no data");
});

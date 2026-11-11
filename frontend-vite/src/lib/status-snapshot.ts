import { isThemePreference, type ThemePreference } from "./theme";

export type MonitorStatus = "up" | "degraded" | "down" | "unknown";

export interface UptimeDay {
	date: string;
	status: MonitorStatus;
	uptime: number | null;
	degraded: number | null;
}
export interface Monitor {
	id: number;
	name: string;
	description: string;
	uptimeWording: string;
	status: MonitorStatus;
	ts: number;
	history: UptimeDay[];
}
export interface Incident {
	id: number;
	monitor_id: number;
	monitor_name: string;
	type: "down" | "degraded";
	message: string;
	status: "active" | "resolved";
	created: string;
	modified: string;
}

export interface BootstrapSnapshot {
	groups: { name: string; monitors: number[] }[];
	monitors: Monitor[];
	incidents: Incident[];
	public: {
		favicon: string;
		logo: string;
		logoDark: string;
		defaultTheme: ThemePreference;
		companyName: string;
		refreshInterval: number;
		subscriptionsEnabled: boolean;
	};
	updatedAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function id(value: unknown): value is number {
	return finite(value) && Number.isSafeInteger(value) && value > 0;
}
function timestamp(value: unknown): boolean {
	return finite(value) && value >= 0 && value <= 8.64e15;
}
function status(value: unknown): value is MonitorStatus {
	return value === "up" || value === "degraded" || value === "down" || value === "unknown";
}
function percentage(value: unknown): boolean {
	return value === null || (finite(value) && value >= 0 && value <= 100);
}
function day(value: unknown): boolean {
	return (
		record(value) &&
		typeof value.date === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
		status(value.status) &&
		percentage(value.uptime) &&
		percentage(value.degraded) &&
		(value.status === "unknown"
			? value.uptime === null && value.degraded === null
			: value.uptime !== null && value.degraded !== null)
	);
}
function monitor(value: unknown): boolean {
	return (
		record(value) &&
		id(value.id) &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		typeof value.uptimeWording === "string" &&
		status(value.status) &&
		timestamp(value.ts) &&
		Array.isArray(value.history) &&
		value.history.every(day)
	);
}
function incident(value: unknown): boolean {
	return (
		record(value) &&
		id(value.id) &&
		id(value.monitor_id) &&
		typeof value.monitor_name === "string" &&
		(value.type === "down" || value.type === "degraded") &&
		(value.status === "active" || value.status === "resolved") &&
		typeof value.message === "string" &&
		typeof value.created === "string" &&
		typeof value.modified === "string"
	);
}

// Validate both the injected data and fetched JSON before rendering nested fields.
export function parseSnapshot(value: unknown): BootstrapSnapshot | undefined {
	if (!record(value) || !record(value.public)) return undefined;
	const config = value.public;
	if (
		typeof config.companyName !== "string" ||
		typeof config.favicon !== "string" ||
		typeof config.logo !== "string" ||
		typeof config.logoDark !== "string" ||
		!isThemePreference(config.defaultTheme) ||
		!finite(config.refreshInterval) ||
		typeof config.subscriptionsEnabled !== "boolean" ||
		!timestamp(value.updatedAt) ||
		!Array.isArray(value.monitors) ||
		!value.monitors.every(monitor) ||
		!Array.isArray(value.incidents) ||
		!value.incidents.every(incident) ||
		!Array.isArray(value.groups)
	)
		return undefined;
	const monitors = value.monitors as Monitor[];
	const ids = new Set(monitors.map((entry) => entry.id));
	if (ids.size !== monitors.length) return undefined;
	if (
		!value.groups.every(
			(group: unknown) =>
				record(group) &&
				typeof group.name === "string" &&
				Array.isArray(group.monitors) &&
				group.monitors.every((entry: unknown) => id(entry) && ids.has(entry))
		)
	)
		return undefined;
	return value as unknown as BootstrapSnapshot;
}

export function readSnapshot(): BootstrapSnapshot | undefined {
	if (typeof document === "undefined") return undefined;
	const json = document.getElementById("status-snapshot")?.textContent;
	if (!json) return undefined;
	try {
		return parseSnapshot(JSON.parse(json));
	} catch {
		return undefined;
	}
}

export function readSnapshotEtag(): string | undefined {
	if (typeof document === "undefined") return undefined;
	const etag = document.getElementById("status-snapshot")?.getAttribute?.("data-etag");
	return etag && /^(?:W\/)?"[^"\r\n]*"$/.test(etag) ? etag : undefined;
}

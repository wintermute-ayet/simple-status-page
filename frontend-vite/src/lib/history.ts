import type { MonitorStatus, UptimeDay } from "./status-snapshot";

export const statusLabels: Record<MonitorStatus, string> = {
	up: "Operational",
	degraded: "Degraded performance",
	down: "Down",
	unknown: "Unknown"
};
export const statusIcons: Record<MonitorStatus, string> = {
	up: "✓",
	degraded: "!",
	down: "×",
	unknown: "?"
};

export function averageUptime(history: UptimeDay[]): number | null {
	const known = history.filter((day) => day.status !== "unknown" && day.uptime !== null);
	return known.length ? known.reduce((sum, day) => sum + day.uptime!, 0) / known.length : null;
}

export function dayDetails(day: UptimeDay): string {
	if (day.status === "unknown" || day.uptime === null) return `${day.date}: no data`;
	const degraded = day.degraded ?? 0;
	return `${day.date}: ${statusLabels[day.status]}, ${day.uptime.toFixed(2)}% uptime${degraded > 0 ? `, ${degraded.toFixed(2)}% degraded` : ""}`;
}

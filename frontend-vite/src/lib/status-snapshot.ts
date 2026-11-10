import type { Monitor } from "../components/ui/status-monitor";
import type { Incident } from "../components/ui/incident-list";

export interface BootstrapSnapshot {
	groups: { name: string; monitors: number[] }[];
	monitors: Monitor[];
	incidents: Incident[];
	public: {
		favicon: string;
		logo: string;
		companyName: string;
		refreshInterval: number;
		subscriptionsEnabled: boolean;
	};
}

export function readSnapshot(): BootstrapSnapshot | undefined {
	if (typeof document === "undefined") return undefined;
	const json = document.getElementById("status-snapshot")?.textContent;
	if (!json) return undefined;
	try {
		const data = JSON.parse(json) as BootstrapSnapshot;
		if (
			!data ||
			!data.public ||
			!Array.isArray(data.groups) ||
			!Array.isArray(data.monitors) ||
			!Array.isArray(data.incidents)
		)
			return undefined;
		return data;
	} catch {
		return undefined;
	}
}

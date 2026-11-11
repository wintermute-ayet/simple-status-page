import type { BootstrapSnapshot } from "./lib/status-snapshot";

export function exampleSnapshot(): BootstrapSnapshot {
	return {
		public: {
			companyName: "Example",
			logo: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
			logoDark: "",
			defaultTheme: "light",
			favicon: "",
			refreshInterval: 900,
			subscriptionsEnabled: true
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
				ts: Date.UTC(2030, 0, 3),
				history: [
					{ date: "2030-01-01", status: "unknown", uptime: null, degraded: null },
					{ date: "2030-01-02", status: "down", uptime: 50, degraded: 10 },
					{ date: "2030-01-03", status: "up", uptime: 100, degraded: 0 }
				]
			}
		],
		updatedAt: Date.UTC(2030, 0, 3)
	};
}

export function injectSnapshot(snapshot = exampleSnapshot(), etag?: string) {
	const element = document.createElement("script");
	element.type = "application/json";
	element.id = "status-snapshot";
	if (etag) element.setAttribute("data-etag", etag);
	element.textContent = JSON.stringify(snapshot);
	document.head.appendChild(element);
	return element;
}

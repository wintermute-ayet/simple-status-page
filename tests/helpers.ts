import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Koa from "koa";
import { validateConfig } from "../src/config";

export const testToken = "test-primary-monitor-token";
export const testEmail = ["subscriber", "example.com"].join("@");
export function rawConfig(
	monitor: Record<string, unknown> = {},
	root: Record<string, unknown> = {}
) {
	return {
		public: { companyName: "Example", basedomain: "https://example.com" },
		salt: "test-subscription-secret-for-unit-tests",
		database: { path: ":memory:" },
		groups: [{ name: "Services", monitors: [1] }],
		monitors: [
			{
				id: 1,
				name: "Push monitor",
				type: "api",
				uuid: testToken,
				checkInterval: 1000,
				retries: 3,
				incidents: {
					down: { createAfter: 1, resolveAfter: 2 },
					degraded: { createAfter: 2, resolveAfter: 2 }
				},
				...monitor
			}
		],
		...root
	};
}
export function makeConfig(
	monitor: Record<string, unknown> = {},
	root: Record<string, unknown> = {}
) {
	return validateConfig(rawConfig(monitor, root));
}
export async function listen(app: Koa): Promise<{ server: Server; url: string }> {
	const callback = app.callback();
	const server = createServer((request, response) => {
		void Promise.resolve(callback(request, response)).catch(() => {
			response.statusCode = 500;
			response.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
export async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
}

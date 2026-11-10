import { readFileSync } from "node:fs";
import { get, type IncomingHttpHeaders } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { AxiosHeaders } from "axios";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/server";
import { createIncident, initializeDatabase } from "../src/database";
import migrateDatabase from "../src/database-migrations";
import type { Config } from "../src/config";
import type { HttpRequest } from "../src/monitors";
import type { StatusSnapshot } from "../src/status";
import { close, listen, makeConfig, rawConfig, testToken } from "./helpers";

let db: Database;
let service: ReturnType<typeof createApplication>;
let listener: Awaited<ReturnType<typeof listen>> | undefined;
const template = readFileSync("frontend-vite/index.html", "utf8");
beforeEach(() => {
	db = initializeDatabase(":memory:");
	migrateDatabase(db);
	vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => {
	if (listener) await close(listener.server);
	await service?.runtime.stop();
	service?.mail?.close();
	await service?.mail?.drain();
	db.close();
	listener = undefined;
});
async function start(config = makeConfig(), request?: HttpRequest) {
	service = createApplication(config, db, { indexHtml: template, request });
	listener = await listen(service.app);
	return listener.url;
}
function raw(
	url: string,
	headers: Record<string, string> = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		get(url, { headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("error", reject);
			response.on("end", () =>
				resolve({
					status: response.statusCode!,
					headers: response.headers,
					body: Buffer.concat(chunks)
				})
			);
		}).on("error", reject);
	});
}
async function snapshot(url: string): Promise<StatusSnapshot> {
	return (await (await fetch(url + "/api/status")).json()) as StatusSnapshot;
}
function injected(html: string): StatusSnapshot {
	const json =
		/<script type="application\/json" id="status-snapshot" data-etag="[^"]*">([\s\S]*?)<\/script>/.exec(
			html
		)![1];
	expect(json).not.toContain("<");
	return JSON.parse(json) as StatusSnapshot;
}

describe("cached status endpoint", () => {
	it("serves public config, groups, monitor metadata, nullable history and incidents without secrets", async () => {
		const config = makeConfig(
			{},
			{
				monitors: [
					rawConfig().monitors[0],
					{ ...rawConfig({ visible: false, uuid: "test-hidden-monitor-token" }).monitors[0], id: 2 }
				]
			}
		);
		const url = await start(config);
		const data = await snapshot(url);
		expect(data.public).toMatchObject({ companyName: "Example", subscriptionsEnabled: false });
		expect(data.groups).toEqual([{ name: "Services", monitors: [1] }]);
		expect(data.monitors).toHaveLength(1);
		expect(data.monitors[0]).toMatchObject({
			id: 1,
			name: "Push monitor",
			description: "",
			uptimeWording: "uptime",
			status: "unknown",
			uptime: null,
			incident: null
		});
		expect(data.monitors[0].history).toHaveLength(91);
		expect(
			data.monitors[0].history.every((day) => day.uptime === null && day.status === "unknown")
		).toBe(true);
		expect(data.incidents).toEqual([]);
		for (const privateValue of [
			testToken,
			config.salt,
			"test-hidden-monitor-token",
			'"uuid"',
			'"tokens"',
			'"smtp"',
			'"database"'
		])
			expect(JSON.stringify(data)).not.toContain(privateValue);
	});
	it("excludes ungrouped visible monitors and their incidents from JSON and injected HTML", async () => {
		const ungrouped = rawConfig({
			id: 3,
			name: "Ungrouped service",
			visible: true,
			uuid: "test-ungrouped-monitor-token"
		}).monitors[0];
		const config = makeConfig({}, { monitors: [rawConfig().monitors[0], ungrouped] });
		const url = await start(config);
		expect(createIncident(db, 3, "down", "Ungrouped service outage")).toMatchObject({
			monitor_id: 3,
			status: "active"
		});
		service.status.refresh();
		const data = await snapshot(url);
		expect(data.monitors.map((monitor) => monitor.id)).toEqual([1]);
		expect(data.groups).toEqual([{ name: "Services", monitors: [1] }]);
		expect(data.incidents).toEqual([]);
		const response = await fetch(url + "/");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(injected(html)).toEqual(data);
		expect(html).not.toContain(ungrouped.name);
	});
	it.each([
		{ label: "omitted", groups: undefined },
		{ label: "empty", groups: [] }
	])(
		"serves an empty snapshot and valid injected HTML when groups are $label",
		async ({ groups }) => {
			const url = await start(makeConfig({}, { groups }));
			const data = await snapshot(url);
			expect(data.monitors).toEqual([]);
			expect(data.groups).toEqual([]);
			expect(data.incidents).toEqual([]);
			const response = await fetch(url + "/");
			expect(response.status).toBe(200);
			const html = await response.text();
			expect(injected(html)).toEqual(data);
			expect(html).toContain('<div id="root">');
		}
	);
	it("serves requests from memory with ETag revalidation and quality-aware compression", async () => {
		const url = await start();
		const prepare = vi.spyOn(db, "prepare");
		const plain = await raw(url + "/api/status", { "Accept-Encoding": "identity" });
		expect(plain.status).toBe(200);
		expect(plain.headers["cache-control"]).toBe("public, max-age=15, stale-while-revalidate=60");
		expect(plain.headers.vary).toContain("Accept-Encoding");
		expect(plain.headers["content-type"]).toContain("application/json");
		const etag = plain.headers.etag!;
		for (const tag of [etag, etag.replace(/^W\//, ""), `"unrelated", ${etag}`, "*"]) {
			const cached = await raw(url + "/api/status", {
				"If-None-Match": tag,
				"Accept-Encoding": "gzip"
			});
			expect(cached.status).toBe(304);
			expect(cached.body.length).toBe(0);
			expect(cached.headers.etag).toBe(etag);
		}
		const gzip = await raw(url + "/api/status", { "Accept-Encoding": "gzip" });
		expect(gzip.headers["content-encoding"]).toBe("gzip");
		expect(gunzipSync(gzip.body)).toEqual(plain.body);
		const br = await raw(url + "/api/status", { "Accept-Encoding": "br" });
		expect(br.headers["content-encoding"]).toBe("br");
		expect(brotliDecompressSync(br.body)).toEqual(plain.body);
		const preferred = await raw(url + "/api/status", { "Accept-Encoding": "br;q=0.1, gzip;q=0.9" });
		expect(preferred.headers["content-encoding"]).toBe("gzip");
		expect((await raw(url + "/api/status", { "If-None-Match": '"stale"' })).status).toBe(200);
		expect(prepare).not.toHaveBeenCalled();
	});
	it("refreshes after API checks and incident creation/resolution, excluding no-data days from uptime", async () => {
		const config = makeConfig();
		const url = await start(config);
		const initialTag = (await fetch(url + "/api/status")).headers.get("ETag")!;
		service.runtime.receiveReport(1, "down", 0);
		await service.runtime.checkApiMonitor(config.monitors[0]);
		const down = await snapshot(url);
		expect(down.monitors[0]).toMatchObject({
			status: "down",
			uptime: 0,
			incident: { status: "active", type: "down" }
		});
		expect(down.incidents).toHaveLength(1);
		expect(
			(await fetch(url + "/api/status", { headers: { "If-None-Match": initialTag } })).status
		).toBe(200);
		service.runtime.receiveReport(1, "up", 2);
		await service.runtime.checkApiMonitor(config.monitors[0]);
		await service.runtime.checkApiMonitor(config.monitors[0]);
		const recovered = await snapshot(url);
		expect(recovered.monitors[0]).toMatchObject({ status: "up", uptime: 66.67, incident: null });
		expect(recovered.incidents[0].status).toBe("resolved");
		expect(recovered.monitors[0].history.filter((day) => day.uptime === null)).toHaveLength(90);
		expect(injected(await (await fetch(url + "/")).text())).toEqual(recovered);
		// Legacy routes retain their response contracts and raw history.
		expect(await (await fetch(url + "/api/monitor?id=1")).json()).toEqual(
			recovered.monitors[0].history
		);
		expect(await (await fetch(url + "/api/incidents")).json()).toEqual(recovered.incidents);
	});
	it("refreshes after HTTP checks and counts unknown API checks only in raw history", async () => {
		const config: Config = makeConfig({ type: "http", url: "https://example.com", retries: 1 });
		const request: HttpRequest = () =>
			Promise.resolve({
				data: "healthy",
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/plain" },
				config: { headers: new AxiosHeaders() }
			});
		const url = await start(config, request);
		await service.runtime.checkHTTPMonitor(config.monitors[0]);
		expect((await snapshot(url)).monitors[0]).toMatchObject({ status: "up", uptime: 100 });
		expect(db.prepare("SELECT up FROM monitor_daily").get()).toEqual({ up: 1 });
	});
	it("refreshes an unknown check without inventing daily uptime samples", async () => {
		const config = makeConfig({ onMissing: "unknown", retries: 1 });
		const url = await start(config);
		await service.runtime.checkApiMonitor(config.monitors[0]);
		expect((await snapshot(url)).monitors[0]).toMatchObject({ status: "unknown", uptime: null });
		expect(db.prepare("SELECT * FROM monitor_daily").all()).toEqual([]);
		expect(db.prepare("SELECT status FROM monitor_checks").all()).toEqual([{ status: "unknown" }]);
	});
});

describe("startup HTML injection", () => {
	it("escapes titles and JSON and embeds SVG only as data images, including Unicode", async () => {
		const name = 'Example </title><script>alert("unsafe")</script> & service';
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Example ✓ </script></text></svg>';
		const url = await start(
			makeConfig(
				{},
				{
					public: { companyName: name, basedomain: "https://example.com", logo: svg, favicon: svg }
				}
			)
		);
		const response = await fetch(url + "/");
		const html = await response.text();
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
		expect(html).not.toContain('<script>alert("unsafe")');
		expect(html).toContain("data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"));
		expect(html).toContain('rel="icon"');
		expect(html).toContain('<img src="data:image/svg+xml;base64,');
		expect(injected(html).public).toMatchObject({ companyName: name, logo: svg, favicon: svg });
		const status = await fetch(url + "/api/status");
		const etag = status.headers.get("ETag")!;
		expect(html).toContain(`data-etag="${etag.replace(/"/g, "&quot;")}"`);
		expect((await fetch(url + "/api/status", { headers: { "If-None-Match": etag } })).status).toBe(
			304
		);
		expect(await (await fetch(url + "/index.html")).text()).toBe(html);
	});
});

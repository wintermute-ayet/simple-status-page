import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication, parseReport } from "../src/server";
import { initializeDatabase, type MonitorState } from "../src/database";
import migrateDatabase from "../src/database-migrations";
import { close, listen, makeConfig, testEmail, testToken } from "./helpers";

let db: Database;
let service: ReturnType<typeof createApplication>;
let listener: Awaited<ReturnType<typeof listen>> | undefined;
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
async function start() {
	service = createApplication(makeConfig(), db);
	listener = await listen(service.app);
	return listener.url;
}

describe("server routes", () => {
	it("serves health and disables subscription routes/UI data without SMTP", async () => {
		const url = await start();
		expect(await (await fetch(url + "/healthz")).json()).toEqual({ status: "ok" });
		const overview = (await (await fetch(url + "/api/overview")).json()) as {
			public: { subscriptionsEnabled: boolean };
		};
		expect(overview.public.subscriptionsEnabled).toBe(false);
		expect(
			(
				await fetch(url + "/api/subscribe", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email: testEmail })
				})
			).status
		).toBe(404);
	});
	it("preserves GET push compatibility and persists the report before the interval", async () => {
		const url = await start();
		expect(
			await (await fetch(`${url}/api/monitor/${testToken}?status=up&value=12.5`)).json()
		).toEqual({ status: "ok" });
		expect(db.prepare("SELECT * FROM monitor_state").get()).toMatchObject({
			last_status: "up",
			last_value: 12.5
		});
		await service.runtime.checkApiMonitor(makeConfig().monitors[0]);
		const overview = (await (await fetch(url + "/api/overview")).json()) as {
			monitors: { status: string }[];
		};
		expect(overview.monitors[0].status).toBe("up");
	});
	it("validates monitor ids and finite report values", async () => {
		const url = await start();
		for (const id of ["", "NaN", "Infinity", "1x", "1.5", "-1", "9007199254740993"])
			expect((await fetch(`${url}/api/monitor?id=${id}`)).status).toBe(400);
		expect((await fetch(url + "/api/monitor")).status).toBe(400);
		expect((await fetch(url + "/api/monitor?id=2")).status).toBe(404);
		for (const value of ["NaN", "Infinity", "", "12abc"])
			expect((await fetch(`${url}/api/monitor/${testToken}?status=up&value=${value}`)).status).toBe(
				400
			);
		expect(db.prepare("SELECT * FROM monitor_state").all()).toEqual([]);
	});
	it("returns persisted latest status before another scheduled check", async () => {
		const config = makeConfig();
		service = createApplication(config, db);
		service.runtime.receiveReport(1, "degraded", 8);
		await service.runtime.checkApiMonitor(config.monitors[0]);
		await service.runtime.stop();
		service = createApplication(config, db);
		listener = await listen(service.app);
		const overview = (await (await fetch(listener.url + "/api/overview")).json()) as {
			monitors: { status: string }[];
		};
		expect(overview.monitors[0].status).toBe("degraded");
		expect((db.prepare("SELECT * FROM monitor_state").get() as MonitorState).up_count).toBe(1);
	});
});

it("parses numeric reports without accepting non-finite or composite values", () => {
	expect(parseReport("up", undefined)).toEqual({ status: "up", value: 0 });
	expect(parseReport("degraded", "2.5")).toEqual({ status: "degraded", value: 2.5 });
	for (const value of [NaN, Infinity, "NaN", "Infinity", [], {}, ""])
		expect(parseReport("up", value)).toBeUndefined();
	expect(parseReport("unknown", 1)).toBeUndefined();
});

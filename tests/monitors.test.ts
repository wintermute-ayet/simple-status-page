import { AxiosHeaders, type AxiosResponse } from "axios";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorRuntime, type HttpRequest, type NotifyIncident } from "../src/monitors";
import { initializeDatabase, type MonitorState } from "../src/database";
import migrateDatabase from "../src/database-migrations";
import * as database from "../src/database";
import { makeConfig, testToken } from "./helpers";

let db: Database;
let runtime: MonitorRuntime;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	db = initializeDatabase(":memory:");
	migrateDatabase(db);
});
afterEach(async () => {
	await runtime?.stop();
	db.close();
	vi.useRealTimers();
});
function state(): MonitorState {
	return db.prepare("SELECT * FROM monitor_state WHERE monitor_id=1").get() as MonitorState;
}
function checks(): { status: string; val: number }[] {
	return db.prepare("SELECT status, val FROM monitor_checks ORDER BY id").all() as {
		status: string;
		val: number;
	}[];
}
function response(
	data: unknown = "healthy",
	status = 200,
	contentType = "text/plain"
): AxiosResponse<unknown> {
	return {
		data,
		status,
		statusText: "Result",
		headers: { "content-type": contentType },
		config: { headers: new AxiosHeaders() }
	};
}

describe("API monitor state", () => {
	it("requires resolveAfter consecutive up checks to resolve a degraded incident", async () => {
		const config = makeConfig({ incidents: { degraded: { createAfter: 3, resolveAfter: 3 } } });
		const resolved = vi.spyOn(database, "resolveIncident");
		runtime = new MonitorRuntime(config, db);
		runtime.receiveReport(1, "degraded", 0);
		for (let check = 0; check < 3; check++) await runtime.checkApiMonitor(config.monitors[0]);
		expect(state()).toMatchObject({ up_count: 3, healthy_count: 0 });
		expect(db.prepare("SELECT status FROM incidents").all()).toEqual([{ status: "active" }]);
		runtime.receiveReport(1, "up", 0);
		for (let check = 0; check < 2; check++) await runtime.checkApiMonitor(config.monitors[0]);
		expect(db.prepare("SELECT status FROM incidents").all()).toEqual([{ status: "active" }]);
		expect(resolved).not.toHaveBeenCalled();
		await runtime.stop();
		runtime = new MonitorRuntime(config, db);
		expect(state().healthy_count).toBe(2);
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(resolved).toHaveBeenCalledExactlyOnceWith(db, 1, "degraded");
		expect(db.prepare("SELECT status FROM incidents").all()).toEqual([{ status: "resolved" }]);
	});
	it("keeps one degraded incident across degraded/up/degraded flapping", async () => {
		const config = makeConfig({ incidents: { degraded: { createAfter: 1, resolveAfter: 2 } } });
		runtime = new MonitorRuntime(config, db);
		for (const status of ["degraded", "up", "degraded"] as const) {
			runtime.receiveReport(1, status, 0);
			await runtime.checkApiMonitor(config.monitors[0]);
		}
		expect(db.prepare("SELECT status FROM incidents").all()).toEqual([{ status: "active" }]);
		expect(state().healthy_count).toBe(0);
	});
	it("keeps never-reported monitors down after exhausting retries", async () => {
		const config = makeConfig();
		runtime = new MonitorRuntime(config, db);
		await runtime.checkApiMonitor(config.monitors[0]);
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(checks()).toEqual([]);
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(checks()).toEqual([{ status: "down", val: 0 }]);
		expect(state().down_count).toBe(1);
	});
	it.each(["up", "degraded", "down"] as const)(
		"records fresh %s and its value immediately after a long outage",
		async (status) => {
			const config = makeConfig();
			runtime = new MonitorRuntime(config, db);
			for (let index = 0; index < 10; index++) await runtime.checkApiMonitor(config.monitors[0]);
			const before = checks().length;
			runtime.receiveReport(1, status, 37);
			vi.setSystemTime(Date.now() + 1000);
			await runtime.checkApiMonitor(config.monitors[0]);
			expect(checks()).toHaveLength(before + 1);
			expect(checks().at(-1)).toEqual({ status, val: 37 });
			expect(state().retries).toBe(0);
			if (status !== "down") expect(state().up_count).toBe(1);
		}
	);
	it.each([
		[3000, "up"],
		[3001, "down"]
	] as const)("handles a report aged %i ms at the recovery boundary", async (age, expected) => {
		const config = makeConfig();
		runtime = new MonitorRuntime(config, db);
		for (let index = 0; index < 3; index++) await runtime.checkApiMonitor(config.monitors[0]);
		runtime.receiveReport(1, "up", 42);
		vi.setSystemTime(Date.now() + age);
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(checks().at(-1)).toEqual({ status: expected, val: expected === "up" ? 42 : 0 });
	});
	it("writes once and tracks the incident once on the retry-threshold tick", async () => {
		const config = makeConfig();
		runtime = new MonitorRuntime(config, db);
		runtime.receiveReport(1, "up", 11);
		vi.setSystemTime(Date.now() + 3001);
		await runtime.checkApiMonitor(config.monitors[0]);
		await runtime.checkApiMonitor(config.monitors[0]);
		const before = checks().length;
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(checks()).toHaveLength(before + 1);
		expect(checks().at(-1)).toEqual({ status: "down", val: 0 });
		expect(state()).toMatchObject({ down_count: 1, up_count: 0, retries: 3 });
	});
	it("persists reports and retries across runtime restarts", async () => {
		const config = makeConfig();
		runtime = new MonitorRuntime(config, db);
		runtime.receiveReport(1, "up", 19);
		vi.setSystemTime(Date.now() + 3001);
		await runtime.checkApiMonitor(config.monitors[0]);
		await runtime.checkApiMonitor(config.monitors[0]);
		await runtime.stop();
		runtime = new MonitorRuntime(config, db);
		expect(state()).toMatchObject({ last_status: "up", last_value: 19, retries: 2 });
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(checks().at(-1)?.status).toBe("down");
	});
	it("recovers incidents after mixed up/degraded checks across a restart", async () => {
		const config = makeConfig();
		runtime = new MonitorRuntime(config, db);
		for (let index = 0; index < 3; index++) await runtime.checkApiMonitor(config.monitors[0]);
		runtime.receiveReport(1, "up", 1);
		await runtime.checkApiMonitor(config.monitors[0]);
		await runtime.stop();
		runtime = new MonitorRuntime(config, db);
		runtime.receiveReport(1, "degraded", 2);
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(db.prepare("SELECT status FROM incidents WHERE type='down'").get()).toEqual({
			status: "resolved"
		});
		expect(state().up_count).toBe(2);
	});
	it("resets the recovery streak on unknown checks and supports onMissing unknown", async () => {
		const config = makeConfig({ onMissing: "unknown", retries: 1 });
		runtime = new MonitorRuntime(config, db);
		runtime.receiveReport(1, "up", 2);
		await runtime.checkApiMonitor(config.monitors[0]);
		vi.setSystemTime(Date.now() + 1001);
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(checks().at(-1)).toEqual({ status: "unknown", val: 0 });
		expect(state()).toMatchObject({
			down_count: 0,
			degraded_count: 0,
			up_count: 0,
			healthy_count: 0
		});
		expect(db.prepare("SELECT * FROM incidents").all()).toEqual([]);
	});
	it("retains the visibility guard", async () => {
		const config = makeConfig({ visible: false, retries: 1 });
		runtime = new MonitorRuntime(config, db);
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(checks()).toHaveLength(1);
		expect(db.prepare("SELECT * FROM incidents").all()).toEqual([]);
	});
	it("rolls back incidents, checks and counters together on a failed state write", async () => {
		const config = makeConfig();
		runtime = new MonitorRuntime(config, db);
		runtime.receiveReport(1, "down", 7);
		db.exec(
			"CREATE TRIGGER fail_state BEFORE UPDATE ON monitor_state BEGIN SELECT RAISE(ABORT, 'simulated failure'); END"
		);
		await expect(runtime.checkApiMonitor(config.monitors[0])).rejects.toThrow("simulated failure");
		expect(checks()).toEqual([]);
		expect(state().down_count).toBe(0);
		expect(db.prepare("SELECT * FROM incidents").all()).toEqual([]);
		db.exec("DROP TRIGGER fail_state");
		await runtime.checkApiMonitor(config.monitors[0]);
		expect(state().down_count).toBe(1);
	});
});

describe("HTTP monitors", () => {
	const httpConfig = (monitor: Record<string, unknown> = {}) =>
		makeConfig({
			type: "http",
			url: "https://example.com",
			retries: 1,
			timeoutDownMs: 1000,
			timeoutDegradedMs: 100,
			regexp: "healthy",
			...monitor
		});
	it("persists checks and notifies incidents when snapshot refresh throws", async () => {
		const config = httpConfig();
		const notify = vi.fn<NotifyIncident>().mockResolvedValue(undefined);
		const request = vi.fn<HttpRequest>().mockResolvedValue(response("unavailable", 503));
		const refresh = vi.fn(() => {
			throw new Error(`Snapshot unavailable: ${testToken}`);
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		runtime = new MonitorRuntime(config, db, notify, request, refresh);
		await expect(runtime.checkHTTPMonitor(config.monitors[0])).resolves.toBeUndefined();
		expect(checks()).toEqual([{ status: "down", val: 0 }]);
		expect(state()).toMatchObject({ last_status: "down", down_count: 1, retries: 1 });
		expect(db.prepare("SELECT status FROM incidents").all()).toEqual([{ status: "active" }]);
		expect(notify).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ monitor_id: 1, type: "down", status: "active" })
		);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(logged).toHaveBeenCalledWith(
			"Status snapshot refresh failed",
			expect.objectContaining({
				message: "Snapshot unavailable: [REDACTED]",
				stack: expect.stringContaining("[REDACTED]")
			})
		);
		expect(JSON.stringify(logged.mock.calls)).not.toContain(testToken);
	});
	it("stores the measured elapsed time and uses it for degradation", async () => {
		const config = httpConfig();
		const request = vi.fn<HttpRequest>().mockImplementation(() => {
			vi.setSystemTime(Date.now() + 150);
			return Promise.resolve(response());
		});
		runtime = new MonitorRuntime(config, db, undefined, request);
		await runtime.checkHTTPMonitor(config.monitors[0]);
		expect(checks()).toEqual([{ status: "degraded", val: 150 }]);
		expect(request.mock.calls[0][1]).toMatchObject({
			responseType: "text",
			timeout: 1000,
			maxContentLength: 1048576,
			maxBodyLength: 1048576,
			maxRedirects: 5,
			headers: { "User-Agent": "simple-status-page/1.0" }
		});
	});
	it("measures failed requests without shadowing elapsed time", async () => {
		const config = httpConfig();
		const request = vi.fn<HttpRequest>().mockImplementation(() => {
			vi.setSystemTime(Date.now() + 200);
			return Promise.reject(new Error("Request failed"));
		});
		runtime = new MonitorRuntime(config, db, undefined, request);
		await runtime.checkHTTPMonitor(config.monitors[0]);
		expect(checks()).toEqual([{ status: "down", val: 200 }]);
	});
	it("logs failure code, HTTP status, message and stack while redacting tokens", async () => {
		const config = httpConfig();
		const error = Object.assign(
			new Error(`Failed GET https://example.com/api/monitor/${testToken}`),
			{ code: "ECONNRESET", response: { status: 502 } }
		);
		runtime = new MonitorRuntime(
			config,
			db,
			undefined,
			vi.fn<HttpRequest>().mockRejectedValue(error)
		);
		await runtime.checkHTTPMonitor(config.monitors[0]);
		expect(console.warn).toHaveBeenCalledWith(
			"HTTP monitor #1 request failed",
			expect.objectContaining({
				code: "ECONNRESET",
				status: 502,
				message: expect.stringContaining("Failed GET"),
				stack: expect.stringContaining("Error:")
			})
		);
		expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(testToken);
	});
	it.each(["", "application/octet-stream"])(
		"does not gate content type %j without a regexp",
		async (contentType) => {
			const config = httpConfig({ regexp: "" });
			runtime = new MonitorRuntime(
				config,
				db,
				undefined,
				vi.fn<HttpRequest>().mockResolvedValue(response("non-empty body", 200, contentType))
			);
			await runtime.checkHTTPMonitor(config.monitors[0]);
			expect(checks().at(-1)?.status).toBe("up");
		}
	);
	it.each([
		['{"status":"healthy"}', "application/json", "up"],
		["healthy", "", "up"],
		[{ healthy: true }, "application/json", "down"],
		["healthy", "application/octet-stream", "down"],
		["bad", "text/plain", "down"],
		["healthy" + "x".repeat(1048576), "text/plain", "down"]
	])("validates textual bodies and patterns", async (body, contentType, status) => {
		const config = httpConfig();
		const request = vi
			.fn<HttpRequest>()
			.mockResolvedValue(response(body, 200, String(contentType)));
		runtime = new MonitorRuntime(config, db, undefined, request);
		await runtime.checkHTTPMonitor(config.monitors[0]);
		expect(checks().at(-1)?.status).toBe(status);
	});
	it("uses configured status codes including non-2xx responses", async () => {
		const config = httpConfig({ validStatusCodes: [404] });
		runtime = new MonitorRuntime(
			config,
			db,
			undefined,
			vi.fn<HttpRequest>().mockResolvedValue(response("healthy", 404))
		);
		await runtime.checkHTTPMonitor(config.monitors[0]);
		expect(checks().at(-1)?.status).toBe("up");
	});
	it("resets healthy recovery even when an HTTP failure is still below the retry threshold", async () => {
		const config = httpConfig({
			retries: 3,
			incidents: { degraded: { createAfter: 1, resolveAfter: 2 } }
		});
		const request = vi
			.fn<HttpRequest>()
			.mockImplementationOnce(() => {
				vi.setSystemTime(Date.now() + 150);
				return Promise.resolve(response());
			})
			.mockResolvedValueOnce(response())
			.mockRejectedValueOnce(new Error("Temporary failure"))
			.mockResolvedValueOnce(response());
		runtime = new MonitorRuntime(config, db, undefined, request);
		for (let check = 0; check < 4; check++) await runtime.checkHTTPMonitor(config.monitors[0]);
		expect(state().healthy_count).toBe(1);
		expect(db.prepare("SELECT status FROM incidents").all()).toEqual([{ status: "active" }]);
	});
	it("prevents overlapping requests for one monitor", async () => {
		const config = httpConfig();
		let finish!: (value: AxiosResponse<unknown>) => void;
		const request = vi.fn<HttpRequest>().mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		runtime = new MonitorRuntime(config, db, undefined, request);
		const first = runtime.checkHTTPMonitor(config.monitors[0]);
		await runtime.checkHTTPMonitor(config.monitors[0]);
		expect(request).toHaveBeenCalledTimes(1);
		finish(response());
		await first;
		expect(checks()).toHaveLength(1);
	});
	it("starts HTTP checks promptly with deterministic jitter and stops future checks", async () => {
		vi.useFakeTimers();
		const config = httpConfig();
		const request = vi.fn<HttpRequest>().mockResolvedValue(response());
		runtime = new MonitorRuntime(config, db, undefined, request);
		runtime.start();
		expect(request).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(request).toHaveBeenCalledTimes(1);
		await runtime.stop();
		await vi.advanceTimersByTimeAsync(10000);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it.each([
		[1000, 37],
		[5000, 185],
		[60000, 370]
	])("scales startup jitter with interval %i", async (checkInterval, delay) => {
		vi.useFakeTimers();
		const config = httpConfig({ checkInterval });
		const request = vi.fn<HttpRequest>().mockResolvedValue(response());
		runtime = new MonitorRuntime(config, db, undefined, request);
		runtime.start();
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(request).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(1);
	});
});

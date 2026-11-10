import { createServer } from "node:http";
import Koa from "koa";
import Router from "@koa/router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config";

const mocks = vi.hoisted(() => ({
	readConfig: vi.fn(),
	db: {},
	addMonitorStatus: vi.fn(),
	createIncident: vi.fn(),
	resolveIncident: vi.fn()
}));

vi.mock("../src/config", () => ({ readConfig: mocks.readConfig }));
vi.mock("../src/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/database")>()),
	initializeDatabase: () => mocks.db,
	addMonitorStatus: mocks.addMonitorStatus,
	createIncident: mocks.createIncident,
	resolveIncident: mocks.resolveIncident,
	getActiveSubscribers: () => [],
	cleanupTables: vi.fn()
}));
vi.mock("../src/database-migrations", () => ({ default: vi.fn() }));
vi.mock("console-stamp", () => ({ default: vi.fn() }));
vi.mock("nodemailer", () => ({
	default: { createTransport: () => ({ sendMail: vi.fn() }) }
}));

const checkInterval = 1000;
const retries = 3;
let config: Config;
let router: Router;

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	// Keep the real route registration and timers, without opening a listening socket.
	vi.spyOn(Koa.prototype, "listen").mockReturnValue(createServer());
	const registrations = vi.spyOn(Router.prototype, "get");
	config = {
		public: {
			favicon: "",
			logo: "",
			companyName: "Example",
			refreshInterval: 60,
			basedomain: "https://example.com"
		},
		salt: "test-salt",
		smtp: { host: "localhost", from: "Example", port: 25, username: "", password: "" },
		groups: [],
		database: { path: ":memory:" },
		monitors: [
			{
				id: 1,
				name: "Push monitor",
				description: "",
				uuid: "test-monitor-token",
				visible: true,
				type: "api",
				url: "",
				checkInterval,
				retries,
				timeoutDownMs: 1000,
				timeoutDegradedMs: 500,
				uptimeWording: "uptime",
				group: "",
				regexp: "",
				validStatusCodes: [200],
				incidents: {
					down: { createAfter: 1, resolveAfter: 1, message: "Test outage" },
					degraded: { createAfter: 1, resolveAfter: 1, message: "Test degradation" }
				}
			}
		]
	};
	mocks.readConfig.mockReturnValue(config);
	await import("../src/server");
	router = registrations.mock.contexts[0] as Router;
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function report(status: string, value = 0) {
	const route = router.stack.find((layer) => layer.path === "/api/monitor/test-monitor-token");
	expect(route).toBeDefined();
	const ctx = {
		request: { query: { status, value: String(value) } }
	} as unknown as Router.RouterContext;
	await route!.stack[0](ctx, async () => {});
	expect(ctx.body).toEqual({ status: "ok" });
}

async function exhaustRetries() {
	await vi.advanceTimersByTimeAsync(checkInterval * 10);
	expect(mocks.addMonitorStatus).toHaveBeenLastCalledWith(mocks.db, 1, "down", 0);
	mocks.addMonitorStatus.mockClear();
	mocks.createIncident.mockClear();
	mocks.resolveIncident.mockClear();
}

it("serves the container health check", async () => {
	const route = router.stack.find((layer) => layer.path === "/healthz");
	expect(route).toBeDefined();
	const ctx = {} as Router.RouterContext;
	await route!.stack[0](ctx, async () => {});
	expect(ctx.body).toEqual({ status: "ok" });
});

describe("API monitor checks", () => {
	it("waits for the retry threshold, then records down when no report exists", async () => {
		await vi.advanceTimersByTimeAsync(checkInterval * (retries - 1));
		expect(mocks.addMonitorStatus).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(checkInterval);
		expect(mocks.addMonitorStatus).toHaveBeenCalledExactlyOnceWith(mocks.db, 1, "down", 0);
		expect(mocks.createIncident).toHaveBeenCalledWith(mocks.db, 1, "down", "Test outage");
	});

	it.each(["up", "degraded", "down"])(
		"records a fresh %s report and its value on the first check after a long outage",
		async (status) => {
			await exhaustRetries();
			await report(status, 37);
			await vi.advanceTimersByTimeAsync(checkInterval);
			expect(mocks.addMonitorStatus).toHaveBeenCalledExactlyOnceWith(mocks.db, 1, status, 37);
			if (status === "up") {
				expect(mocks.resolveIncident).toHaveBeenCalledWith(mocks.db, 1, "down");
				expect(mocks.resolveIncident).toHaveBeenCalledWith(mocks.db, 1, "degraded");
				expect(mocks.createIncident).not.toHaveBeenCalled();
			} else {
				expect(mocks.createIncident).toHaveBeenCalledExactlyOnceWith(
					mocks.db,
					1,
					status,
					status === "down" ? "Test outage" : "Test degradation"
				);
			}
		}
	);

	it("accepts a recovered report exactly at the freshness boundary", async () => {
		await exhaustRetries();
		await report("up", 42);
		vi.setSystemTime(Date.now() + checkInterval * (retries - 1));
		await vi.advanceTimersByTimeAsync(checkInterval);
		expect(mocks.addMonitorStatus).toHaveBeenCalledExactlyOnceWith(mocks.db, 1, "up", 42);
	});

	it("continues tracking down when the last report is one millisecond too old", async () => {
		await exhaustRetries();
		await report("up", 42);
		vi.setSystemTime(Date.now() + checkInterval * (retries - 1) + 1);
		await vi.advanceTimersByTimeAsync(checkInterval);
		expect(mocks.addMonitorStatus).toHaveBeenCalledExactlyOnceWith(mocks.db, 1, "down", 0);
		expect(mocks.createIncident).toHaveBeenCalledWith(mocks.db, 1, "down", "Test outage");
	});

	it("resets the retry counter after recovery", async () => {
		await exhaustRetries();
		await report("up", 37);
		await vi.advanceTimersByTimeAsync(checkInterval);
		mocks.addMonitorStatus.mockClear();
		// Let that report expire without running intermediate checks.
		vi.setSystemTime(Date.now() + checkInterval * retries);
		await vi.advanceTimersByTimeAsync(checkInterval);
		expect(mocks.addMonitorStatus).toHaveBeenCalledExactlyOnceWith(mocks.db, 1, "up", 37);
		await vi.advanceTimersByTimeAsync(checkInterval * (retries - 1));
		expect(mocks.addMonitorStatus).toHaveBeenLastCalledWith(mocks.db, 1, "down", 0);
	});

	it("stores recovery for an invisible monitor without tracking incidents", async () => {
		config.monitors[0].visible = false;
		await exhaustRetries();
		await report("degraded", 13);
		await vi.advanceTimersByTimeAsync(checkInterval);
		expect(mocks.addMonitorStatus).toHaveBeenCalledExactlyOnceWith(mocks.db, 1, "degraded", 13);
		expect(mocks.createIncident).not.toHaveBeenCalled();
		expect(mocks.resolveIncident).not.toHaveBeenCalled();
	});

	it("records reports normally before the retry threshold is reached", async () => {
		await report("up", 9);
		await vi.advanceTimersByTimeAsync(checkInterval);
		expect(mocks.addMonitorStatus).toHaveBeenCalledExactlyOnceWith(mocks.db, 1, "up", 9);
	});
});

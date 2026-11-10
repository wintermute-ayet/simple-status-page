import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import type { SendMailOptions } from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication, parseReport } from "../src/server";
import {
	addSubscriber,
	activateSubscriber,
	getSubscriber,
	initializeDatabase,
	type MonitorState
} from "../src/database";
import migrateDatabase from "../src/database-migrations";
import { MailQueue } from "../src/mail";
import { SubscriptionLinks } from "../src/security";
import { close, listen, makeConfig, rawConfig, testEmail, testToken } from "./helpers";

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
async function start(config = makeConfig(), mail?: MailQueue) {
	service = createApplication(config, db, { mail });
	listener = await listen(service.app);
	return listener.url;
}

const rotationToken = "test-rotated-monitor-token";
function mailFixture() {
	const messages: SendMailOptions[] = [];
	const sendMail = vi.fn((message: SendMailOptions) => {
		messages.push(message);
		return Promise.resolve({});
	});
	const mail = new MailQueue({ sendMail, close() {} });
	const smtp = { host: "smtp.example.com", from: testEmail, port: 587 };
	return { messages, sendMail, mail, config: makeConfig({}, { smtp }) };
}
function localPath(link: string): string {
	const parsed = new URL(link);
	return parsed.pathname + parsed.search;
}
function subscribe(url: string, email: unknown = testEmail, path = "/api/subscribe", headers = {}) {
	return fetch(url + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ email })
	});
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
	it("accepts rotated GET tokens and authenticated JSON or query POST reports", async () => {
		const url = await start(makeConfig({ tokens: [rotationToken] }));
		expect(await (await fetch(`${url}/api/monitor/${rotationToken}?status=up`)).text()).toBe(
			'{"status":"ok"}'
		);
		for (const token of [testToken, rotationToken]) {
			const response = await fetch(`${url}/api/monitor/${testToken}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ status: "degraded", value: 3.5 })
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: "ok" });
			expect(db.prepare("SELECT * FROM monitor_state").get()).toMatchObject({
				last_status: "degraded",
				last_value: 3.5
			});
		}
		expect(
			(
				await fetch(`${url}/api/monitor?status=up&value=8`, {
					method: "POST",
					headers: { Authorization: `Bearer ${rotationToken}` }
				})
			).status
		).toBe(200);
		expect(db.prepare("SELECT * FROM monitor_state").get()).toMatchObject({
			last_status: "up",
			last_value: 8
		});
		expect(console.info).toHaveBeenCalledWith("Monitor #1 callback received (slot 1)");
	});
	it("rejects unauthorized, mismatched and malformed POST reports without logging tokens", async () => {
		const config = makeConfig(
			{},
			{
				monitors: [
					rawConfig().monitors[0],
					{ ...rawConfig({ uuid: rotationToken }).monitors[0], id: 2 }
				]
			}
		);
		const url = await start(config);
		for (const Authorization of [
			"",
			"Basic invalid",
			`Bearer ${testToken} extra`,
			"Bearer short"
		]) {
			const response = await fetch(`${url}/api/monitor/${testToken}?status=down`, {
				method: "POST",
				headers: { Authorization }
			});
			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
			expect(await response.text()).not.toContain(testToken);
		}
		expect(
			(
				await fetch(`${url}/api/monitor/${rotationToken}?status=down`, {
					method: "POST",
					headers: { Authorization: `Bearer ${testToken}` }
				})
			).status
		).toBe(404);
		expect(
			(
				await fetch(`${url}/api/monitor/${testToken}?status=up&value=Infinity`, {
					method: "POST",
					headers: { Authorization: `Bearer ${testToken}` }
				})
			).status
		).toBe(400);
		expect((await fetch(`${url}/api/monitor/${testToken}x?status=up`)).status).toBe(404);
		expect(db.prepare("SELECT * FROM monitor_state").all()).toEqual([]);
		await fetch(`${url}/api/monitor/${testToken}?status=up`);
		const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
		expect(logged).toContain("Monitor #1 callback received (slot 0)");
		expect(logged).not.toContain(testToken);
		expect(logged).not.toContain(rotationToken);
	});
	it("disables CORS and proxy trust by default, retaining security headers on errors", async () => {
		const url = await start();
		expect(service.app.proxy).toBe(false);
		const response = await fetch(url + "/api/monitor?id=invalid", {
			headers: { Origin: "https://example.com", "X-Forwarded-Proto": "https" }
		});
		expect(response.status).toBe(400);
		expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
		expect(response.headers.has("Strict-Transport-Security")).toBe(false);
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
	});
	it("allows only configured CORS origins, including bearer preflight", async () => {
		const url = await start(makeConfig({}, { cors: ["https://example.com"], proxy: true }));
		expect(service.app.proxy).toBe(true);
		expect(service.app.maxIpsCount).toBe(1);
		const allowed = await fetch(url + "/healthz", { headers: { Origin: "https://example.com" } });
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
		expect(allowed.headers.get("Vary")).toContain("Origin");
		const denied = await fetch(url + "/healthz", {
			headers: { Origin: "https://other.example.com" }
		});
		expect(denied.headers.has("Access-Control-Allow-Origin")).toBe(false);
		const preflight = await fetch(url + "/api/monitor", {
			method: "OPTIONS",
			headers: {
				Origin: "https://example.com",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization,content-type"
			}
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
	});
	it("logs redacted server stacks for 5xx responses", async () => {
		const url = await start();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(service.runtime, "receiveReport").mockImplementation(() => {
			throw new Error(`Failed callback /api/monitor/${testToken}`);
		});
		const response = await fetch(`${url}/api/monitor/${testToken}?status=up`);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal server error" });
		expect(log).toHaveBeenCalledWith(
			"HTTP request failed",
			expect.objectContaining({
				message: expect.stringContaining("Failed callback"),
				stack: expect.stringContaining("Error:")
			})
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain(testToken);
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

describe("subscription routes", () => {
	it.each([
		["x".repeat(64), ["a".repeat(63), "b".repeat(63), "c".repeat(62)].join(".")].join("@"),
		`${testEmail}\r\nBcc: ${testEmail}`,
		`${testEmail},${testEmail}`,
		`Display Name <${testEmail}>`
	])("rejects malformed or oversized recipients before mail.send (%#)", async (email) => {
		const fixture = mailFixture();
		const send = vi.spyOn(fixture.mail, "send");
		const url = await start(fixture.config, fixture.mail);
		expect((await subscribe(url, email)).status).toBe(400);
		expect(send).not.toHaveBeenCalled();
		expect(fixture.sendMail).not.toHaveBeenCalled();
		expect(getSubscriber(db, email)).toBeUndefined();
	});
	it("rejects oversized addresses in signed confirm and unsubscribe links", async () => {
		const fixture = mailFixture();
		const url = await start(fixture.config, fixture.mail);
		const email = ["x".repeat(64), ["a".repeat(63), "b".repeat(63), "c".repeat(62)].join(".")].join(
			"@"
		);
		expect(email).toHaveLength(255);
		addSubscriber(db, email);
		const links = new SubscriptionLinks(fixture.config.salt, fixture.config.public.basedomain);
		for (const purpose of ["confirm", "unsubscribe"] as const) {
			const response = await fetch(url + localPath(links.create(email, purpose)), {
				redirect: "manual"
			});
			expect(response.headers.get("Location")).toBe(
				`/?result=${purpose === "confirm" ? "subscribe" : "unsubscribe"}-error`
			);
			expect(getSubscriber(db, email)?.active).toBe(0);
		}
		expect(fixture.sendMail).not.toHaveBeenCalled();
	});
	it("uses the nearest forwarded client address rather than attacker-controlled prefixes", async () => {
		const fixture = mailFixture();
		const url = await start(
			makeConfig({}, { smtp: fixture.config.smtp, proxy: true }),
			fixture.mail
		);
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				(
					await subscribe(url, "invalid", "/api/subscribe", {
						"X-Forwarded-For": `spoofed-${attempt}, same-client`
					})
				).status
			).toBe(400);
		expect(
			(
				await subscribe(url, testEmail, "/api/subscribe", {
					"X-Forwarded-For": "another-spoof, same-client"
				})
			).status
		).toBe(429);
		expect(fixture.sendMail).not.toHaveBeenCalled();
	});
	it("sends canonical HMAC links, confirms once, and permits signed unsubscribe", async () => {
		const fixture = mailFixture();
		const url = await start(fixture.config, fixture.mail);
		expect((await subscribe(url)).status).toBe(200);
		expect(fixture.messages).toHaveLength(1);
		const confirmation = String(fixture.messages[0].text).match(
			/https:\/\/example\.com\/api\/confirm-subscription\?\S+/
		)?.[0];
		expect(confirmation).toBeDefined();
		const links = new SubscriptionLinks(fixture.config.salt, fixture.config.public.basedomain);
		const params = Object.fromEntries(new URL(confirmation!).searchParams);
		expect(links.verify(testEmail, "confirm", params)).toBe(true);
		expect(getSubscriber(db, testEmail)?.active).toBe(0);
		const confirmed = await fetch(url + localPath(confirmation!), { redirect: "manual" });
		expect(confirmed.headers.get("Location")).toBe("/?result=subscribe-success");
		expect(getSubscriber(db, testEmail)?.active).toBe(1);
		expect((await subscribe(url)).status).toBe(200);
		expect(fixture.messages).toHaveLength(1);
		const headers = fixture.messages[0].headers as Record<string, string>;
		const unsubscribe = headers["List-Unsubscribe"].slice(1, -1);
		expect(
			links.verify(testEmail, "unsubscribe", Object.fromEntries(new URL(unsubscribe).searchParams))
		).toBe(true);
		const removed = await fetch(url + localPath(unsubscribe), { redirect: "manual" });
		expect(removed.headers.get("Location")).toBe("/?result=unsubscribe-success");
		expect(getSubscriber(db, testEmail)).toBeUndefined();
	});
	it("rejects expired, tampered and wrong-purpose links but honors old unsubscribe links", async () => {
		const config = makeConfig();
		const url = await start(config);
		addSubscriber(db, testEmail);
		const links = new SubscriptionLinks(config.salt, config.public.basedomain);
		const expired = links.create(testEmail, "confirm", Date.now() - 49 * 3600 * 1000);
		const tampered = links.create(testEmail, "confirm") + "x";
		const wrongPurpose = links
			.create(testEmail, "unsubscribe")
			.replace("/api/unsubscribe?", "/api/confirm-subscription?");
		const hash = createHash("sha256")
			.update(testEmail + config.salt)
			.digest("base64");
		const legacy = new URLSearchParams({ email: testEmail, hash });
		for (const path of [
			localPath(expired),
			localPath(tampered),
			localPath(wrongPurpose),
			`/api/confirm-subscription?${legacy}`
		]) {
			const response = await fetch(url + path, { redirect: "manual" });
			expect(response.headers.get("Location")).toBe("/?result=subscribe-error");
			expect(getSubscriber(db, testEmail)?.active).toBe(0);
		}
		const invalidUnsubscribe = links
			.create(testEmail, "confirm")
			.replace("/api/confirm-subscription?", "/api/unsubscribe?");
		expect(
			(await fetch(url + localPath(invalidUnsubscribe), { redirect: "manual" })).headers.get(
				"Location"
			)
		).toBe("/?result=unsubscribe-error");
		expect(
			(await fetch(`${url}/api/unsubscribe?${legacy}`, { redirect: "manual" })).headers.get(
				"Location"
			)
		).toBe("/?result=unsubscribe-success");
		expect(getSubscriber(db, testEmail)).toBeUndefined();
	});
	it("rate limits invalid requests too, including route aliases and spoofed forwarded IPs", async () => {
		const fixture = mailFixture();
		const url = await start(fixture.config, fixture.mail);
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(
				(
					await subscribe(url, "invalid", attempt % 2 ? "/API/SUBSCRIBE/" : "/api/subscribe", {
						"X-Forwarded-For": `test-client-${attempt}`
					})
				).status
			).toBe(400);
		}
		const denied = await subscribe(url, testEmail, "/api/subscribe/", {
			"X-Forwarded-For": "another-test-client"
		});
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(Number(denied.headers.get("Retry-After"))).toBeLessThanOrEqual(900);
		expect(fixture.messages).toHaveLength(0);
		expect(getSubscriber(db, testEmail)).toBeUndefined();
	});
	it("applies the global limit across explicitly trusted client IPs", async () => {
		const fixture = mailFixture();
		const url = await start(
			makeConfig({}, { smtp: fixture.config.smtp, proxy: true }),
			fixture.mail
		);
		for (let attempt = 0; attempt < 100; attempt++)
			expect(
				(
					await subscribe(url, "invalid", "/api/subscribe", {
						"X-Forwarded-For": `test-client-${attempt}`
					})
				).status
			).toBe(400);
		const denied = await subscribe(url, testEmail, "/api/subscribe", {
			"X-Forwarded-For": "unused-test-client"
		});
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get("Retry-After"))).toBeLessThanOrEqual(3600);
		expect(fixture.messages).toHaveLength(0);
	});
	it("uses purpose-bound unsubscribe links in incident mail", async () => {
		const fixture = mailFixture();
		const url = await start(fixture.config, fixture.mail);
		addSubscriber(db, testEmail);
		activateSubscriber(db, testEmail);
		await fetch(`${url}/api/monitor/${testToken}?status=down`);
		await service.runtime.checkApiMonitor(fixture.config.monitors[0]);
		expect(fixture.messages).toHaveLength(1);
		const headers = fixture.messages[0].headers as Record<string, string>;
		const unsubscribe = headers["List-Unsubscribe"].slice(1, -1);
		const links = new SubscriptionLinks(fixture.config.salt, fixture.config.public.basedomain);
		expect(
			links.verify(testEmail, "unsubscribe", Object.fromEntries(new URL(unsubscribe).searchParams))
		).toBe(true);
	});
	it("returns controlled SMTP errors and continues serving requests", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fixture = mailFixture();
		fixture.sendMail.mockRejectedValue(new Error("Private SMTP detail"));
		const url = await start(fixture.config, fixture.mail);
		const failed = await subscribe(url);
		expect(failed.status).toBe(503);
		expect(await failed.text()).not.toContain("Private SMTP detail");
		expect(fixture.sendMail).toHaveBeenCalledTimes(3);
		expect((await fetch(url + "/healthz")).status).toBe(200);
	});
});

it("parses numeric reports without accepting non-finite or composite values", () => {
	expect(parseReport("up", undefined)).toEqual({ status: "up", value: 0 });
	expect(parseReport("degraded", "2.5")).toEqual({ status: "degraded", value: 2.5 });
	for (const value of [NaN, Infinity, "NaN", "Infinity", [], {}, ""])
		expect(parseReport("up", value)).toBeUndefined();
	expect(parseReport("unknown", 1)).toBeUndefined();
});

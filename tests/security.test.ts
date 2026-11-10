import { createHash } from "node:crypto";
import Koa from "koa";
import { describe, expect, it } from "vitest";
import {
	constantTimeEqual,
	PushTokens,
	SubscriptionLinks,
	SubscriptionRateLimiter,
	securityHeaders,
	listenOptions
} from "../src/security";
import { close, listen, makeConfig, rawConfig, testEmail, testToken } from "./helpers";

const rotationToken = "test-rotated-monitor-token";
const secret = "test-only-subscription-secret";
const links = new SubscriptionLinks(secret, "https://example.com");
const now = 1800000000000;
const lifetime = 48 * 3600 * 1000;
function parameters(link: string) {
	return Object.fromEntries(new URL(link).searchParams);
}

describe("constant-time token lookup", () => {
	it("compares digest lengths safely, including empty and differently sized inputs", () => {
		expect(constantTimeEqual(testToken, testToken)).toBe(true);
		expect(constantTimeEqual(testToken, testToken + "x")).toBe(false);
		expect(constantTimeEqual(testToken, "")).toBe(false);
		expect(constantTimeEqual("", "")).toBe(true);
	});
	it("matches primary and rotation tokens to the correct API monitor", () => {
		const config = makeConfig(
			{},
			{
				monitors: [
					rawConfig({ tokens: [rotationToken] }).monitors[0],
					{ ...rawConfig({ uuid: "test-second-monitor-token" }).monitors[0], id: 2 },
					{
						...rawConfig({
							type: "http",
							url: "https://example.com",
							uuid: "test-http-unused-token"
						}).monitors[0],
						id: 3
					}
				]
			}
		);
		const tokens = new PushTokens(config.monitors);
		expect(tokens.lookup(testToken)).toMatchObject({ monitor: { id: 1 }, slot: 0 });
		expect(tokens.lookup(rotationToken)).toMatchObject({ monitor: { id: 1 }, slot: 1 });
		expect(tokens.lookup("test-second-monitor-token")).toMatchObject({
			monitor: { id: 2 },
			slot: 0
		});
		for (const value of [
			undefined,
			null,
			[],
			{},
			"",
			"short",
			testToken + "x",
			"test-http-unused-token"
		])
			expect(tokens.lookup(value)).toBeUndefined();
	});
});

describe("subscription signatures", () => {
	it("issues purpose-bound HMAC confirmations valid for exactly 48 hours", () => {
		const confirmation = parameters(links.create(testEmail, "confirm", now));
		expect(Number(confirmation.expires) * 1000).toBe(now + lifetime);
		expect(links.verify(testEmail, "confirm", confirmation, now)).toBe(true);
		expect(links.verify(testEmail, "confirm", confirmation, now + lifetime - 1)).toBe(true);
		expect(links.verify(testEmail, "confirm", confirmation, now + lifetime)).toBe(false);
		expect(links.verify(testEmail, "unsubscribe", confirmation, now)).toBe(false);
		expect(links.verify("other-" + testEmail, "confirm", confirmation, now)).toBe(false);
		for (const patch of [
			{ hash: confirmation.hash + "x" },
			{ hash: "" },
			{ hash: [confirmation.hash] },
			{ purpose: "unsubscribe" },
			{ expires: String(Number(confirmation.expires) + 1) },
			{ expires: "NaN" },
			{ expires: "9007199254740993" },
			{ expires: undefined }
		])
			expect(links.verify(testEmail, "confirm", { ...confirmation, ...patch }, now)).toBe(false);
	});
	it("keeps new unsubscribe links valid without a confirmation expiry", () => {
		const unsubscribe = parameters(links.create(testEmail, "unsubscribe", now));
		expect(unsubscribe.expires).toBe("0");
		expect(links.verify(testEmail, "unsubscribe", unsubscribe, now + lifetime * 1000)).toBe(true);
		expect(links.verify(testEmail, "confirm", unsubscribe, now)).toBe(false);
		expect(links.verify(testEmail, "unsubscribe", { ...unsubscribe, expires: "1" }, now)).toBe(
			false
		);
	});
	it("accepts legacy hashes for unsubscribe only and rejects signature downgrades", () => {
		const hash = createHash("sha256")
			.update(testEmail + secret)
			.digest("base64");
		expect(links.verify(testEmail, "unsubscribe", { hash }, now)).toBe(true);
		expect(links.verify(testEmail, "confirm", { hash }, now)).toBe(false);
		expect(
			links.verify(testEmail, "unsubscribe", { hash, purpose: "confirm", expires: "0" }, now)
		).toBe(false);
		expect(links.verify(testEmail, "unsubscribe", { hash: hash + "x" }, now)).toBe(false);
		const confirmation = parameters(links.create(testEmail, "confirm", now));
		expect(links.verify(testEmail, "unsubscribe", { hash: confirmation.hash }, now)).toBe(false);
		expect(
			new SubscriptionLinks("", "https://example.com").verify(
				testEmail,
				"unsubscribe",
				{ hash },
				now
			)
		).toBe(false);
		expect(() =>
			new SubscriptionLinks("", "https://example.com").create(testEmail, "confirm")
		).toThrow(/secret/);
	});
});

describe("subscription rate limits", () => {
	it("enforces per-IP windows without extending them on rejected attempts", () => {
		const limiter = new SubscriptionRateLimiter(2, 2000, 100, 10000);
		expect(limiter.consume("client-a", now).allowed).toBe(true);
		expect(limiter.consume("client-a", now).allowed).toBe(true);
		expect(limiter.consume("client-a", now)).toEqual({ allowed: false, retryAfter: 2 });
		expect(limiter.consume("client-a", now + 1001)).toEqual({ allowed: false, retryAfter: 1 });
		expect(limiter.consume("client-b", now + 1001).allowed).toBe(true);
		expect(limiter.consume("client-a", now + 2000)).toEqual({ allowed: true, retryAfter: 0 });
	});
	it("enforces a global limit across IPs and resets at the window boundary", () => {
		const limiter = new SubscriptionRateLimiter(5, 1000, 2, 3000);
		expect(limiter.consume("client-a", now).allowed).toBe(true);
		expect(limiter.consume("client-b", now).allowed).toBe(true);
		expect(limiter.consume("client-c", now + 1000)).toEqual({ allowed: false, retryAfter: 2 });
		expect(limiter.consume("client-c", now + 3000)).toEqual({ allowed: true, retryAfter: 0 });
	});
});

describe("HTTP security headers", () => {
	it("restricts scripts, disables framing and caching, and trusts TLS forwarding only explicitly", async () => {
		const app = new Koa();
		app.use(securityHeaders);
		app.use((ctx) => {
			ctx.body = { status: "ok" };
		});
		const listener = await listen(app);
		try {
			const plain = await fetch(listener.url + "/api/example", {
				headers: { "X-Forwarded-Proto": "https" }
			});
			expect(plain.headers.get("Content-Security-Policy")).toContain("script-src 'self';");
			expect(plain.headers.get("Content-Security-Policy")).not.toMatch(/script-src[^;]*'unsafe/);
			expect(plain.headers.get("Content-Security-Policy")).toContain("style-src 'self';");
			expect(plain.headers.get("Content-Security-Policy")).not.toContain("'unsafe-inline'");
			expect(plain.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(plain.headers.get("Referrer-Policy")).toBe("no-referrer");
			expect(plain.headers.get("X-Frame-Options")).toBe("DENY");
			expect(plain.headers.get("Cache-Control")).toBe("no-store");
			expect(plain.headers.has("Strict-Transport-Security")).toBe(false);
			app.proxy = true;
			const secure = await fetch(listener.url + "/", { headers: { "X-Forwarded-Proto": "https" } });
			expect(secure.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
			expect(secure.headers.has("Cache-Control")).toBe(false);
		} finally {
			await close(listener.server);
		}
	});
});

describe("listen configuration", () => {
	it("defaults to the container interface and accepts HOST/PORT overrides", () => {
		expect(listenOptions({})).toEqual({ host: "0.0.0.0", port: 3000 });
		expect(listenOptions({ HOST: " 127.0.0.1 ", PORT: "3001" })).toEqual({
			host: "127.0.0.1",
			port: 3001
		});
		expect(listenOptions({ HOST: " " }).host).toBe("0.0.0.0");
	});
	it.each(["", "0", "-1", "1.5", "3000x", "NaN", "Infinity", "65536", " 3000 "])(
		"rejects invalid PORT %j",
		(PORT) => {
			expect(() => listenOptions({ PORT })).toThrow(/PORT must be an integer/);
		}
	);
});

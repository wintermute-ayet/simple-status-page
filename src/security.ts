import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Middleware } from "koa";
import type { MonitorEntity } from "./config";

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}
export function constantTimeEqual(left: string, right: string): boolean {
	return timingSafeEqual(digest(left), digest(right));
}

export class PushTokens {
	private entries: { monitor: MonitorEntity; tokens: Buffer[] }[];
	constructor(monitors: MonitorEntity[]) {
		this.entries = monitors
			.filter((monitor) => monitor.type === "api")
			.map((monitor) => ({
				monitor,
				tokens: [monitor.uuid, ...monitor.tokens].map(digest)
			}));
	}
	lookup(value: unknown): { monitor: MonitorEntity; slot: number } | undefined {
		if (typeof value !== "string") return undefined;
		const candidate = digest(value);
		let matched: { monitor: MonitorEntity; slot: number } | undefined;
		// Compare every slot, with a fixed-size digest even for differently sized input.
		for (const entry of this.entries) {
			for (const [slot, token] of entry.tokens.entries()) {
				if (timingSafeEqual(candidate, token)) matched = { monitor: entry.monitor, slot };
			}
		}
		return matched;
	}
}

type LinkPurpose = "confirm" | "unsubscribe";
type LinkParameters = { hash?: unknown; purpose?: unknown; expires?: unknown };
export class SubscriptionLinks {
	constructor(
		private secret: string,
		private basedomain: string
	) {}
	private signature(email: string, purpose: LinkPurpose, expires: number): string {
		return createHmac("sha256", this.secret)
			.update(JSON.stringify([email, purpose, expires]))
			.digest("hex");
	}
	create(email: string, purpose: LinkPurpose, now = Date.now()): string {
		if (!this.secret) throw new Error("Subscription link secret is required");
		const expires = purpose === "confirm" ? Math.floor(now / 1000) + 48 * 3600 : 0;
		const endpoint = purpose === "confirm" ? "confirm-subscription" : "unsubscribe";
		const query = new URLSearchParams({
			email,
			purpose,
			expires: String(expires),
			hash: this.signature(email, purpose, expires)
		});
		return `${this.basedomain}/api/${endpoint}?${query}`;
	}
	verify(
		email: string,
		purpose: LinkPurpose,
		parameters: LinkParameters,
		now = Date.now()
	): boolean {
		if (!this.secret || typeof parameters.hash !== "string") return false;
		if (
			purpose === "unsubscribe" &&
			parameters.purpose === undefined &&
			parameters.expires === undefined
		) {
			const legacy = createHash("sha256")
				.update(email + this.secret)
				.digest("base64");
			return constantTimeEqual(parameters.hash, legacy);
		}
		if (
			parameters.purpose !== purpose ||
			typeof parameters.expires !== "string" ||
			!/^\d+$/.test(parameters.expires)
		)
			return false;
		const expires = Number(parameters.expires);
		if (!Number.isSafeInteger(expires)) return false;
		if (purpose === "confirm" ? expires <= Math.floor(now / 1000) : expires !== 0) return false;
		return constantTimeEqual(parameters.hash, this.signature(email, purpose, expires));
	}
}

export class SubscriptionRateLimiter {
	private clients = new Map<string, { count: number; resetAt: number }>();
	private global = { count: 0, resetAt: 0 };
	constructor(
		private perIP = 5,
		private perIPWindowMs = 15 * 60000,
		private total = 100,
		private globalWindowMs = 3600000
	) {}
	consume(ip: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
		for (const [client, bucket] of this.clients)
			if (bucket.resetAt <= now) this.clients.delete(client);
		if (this.global.resetAt <= now) this.global = { count: 0, resetAt: now + this.globalWindowMs };
		const bucket = this.clients.get(ip) ?? { count: 0, resetAt: now + this.perIPWindowMs };
		const wait = Math.max(
			bucket.count >= this.perIP ? bucket.resetAt - now : 0,
			this.global.count >= this.total ? this.global.resetAt - now : 0
		);
		if (wait > 0) return { allowed: false, retryAfter: Math.ceil(wait / 1000) };
		bucket.count++;
		this.global.count++;
		this.clients.set(ip, bucket);
		return { allowed: true, retryAfter: 0 };
	}
}

export const securityHeaders: Middleware = async (ctx, next) => {
	// The frontend uses external CSS and native controls; no inline styles are needed.
	ctx.set(
		"Content-Security-Policy",
		[
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self'",
			"img-src 'self' data:",
			"connect-src 'self'",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'self'",
			"frame-ancestors 'none'"
		].join("; ")
	);
	ctx.set("X-Content-Type-Options", "nosniff");
	ctx.set("Referrer-Policy", "no-referrer");
	ctx.set("X-Frame-Options", "DENY");
	if (ctx.secure) ctx.set("Strict-Transport-Security", "max-age=31536000");
	if (/^\/api\//i.test(ctx.path)) ctx.set("Cache-Control", "no-store");
	await next();
};

export function listenOptions(env: NodeJS.ProcessEnv = process.env): {
	host: string;
	port: number;
} {
	const raw = env.PORT ?? "3000";
	const port = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("PORT must be an integer between 1 and 65535");
	return { host: env.HOST?.trim() || "0.0.0.0", port };
}

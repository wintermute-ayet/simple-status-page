import Koa, { type Context } from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import serve from "koa-static";
import path from "node:path";
import cors from "@koa/cors";
import consoleStamp from "console-stamp";
import validator from "validator";
import { readConfig, type Config, type MonitorStatus } from "./config";
import {
	initializeDatabase,
	getMonitorStatus,
	getMonitorsLatestStatus,
	addSubscriber,
	getSubscriber,
	activateSubscriber,
	deleteSubscriber,
	getIncidents,
	getActiveSubscribers,
	cleanupTables,
	type IncidentRow
} from "./database";
import type { Database } from "better-sqlite3";
import migrateDatabase from "./database-migrations";
import { createMailQueue, type MailQueue } from "./mail";
import { MonitorRuntime, type HttpRequest } from "./monitors";
import { installProcessHandlers } from "./lifecycle";
import {
	PushTokens,
	SubscriptionLinks,
	SubscriptionRateLimiter,
	securityHeaders,
	listenOptions
} from "./security";

export function parseReport(
	status: unknown,
	value: unknown
): { status: MonitorStatus; value: number } | undefined {
	if (status !== "up" && status !== "down" && status !== "degraded") return undefined;
	if (value === undefined) return { status, value: 0 };
	if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "")
		return undefined;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? { status, value: numeric } : undefined;
}

export function createApplication(
	config: Config,
	db: Database,
	options: { mail?: MailQueue; request?: HttpRequest } = {}
) {
	const app = new Koa();
	app.proxy = config.proxy;
	const mail = options.mail ?? createMailQueue(config.smtp);
	const tokens = new PushTokens(config.monitors);
	const links = new SubscriptionLinks(config.salt, config.public.basedomain);
	const subscriptionLimits = new SubscriptionRateLimiter();
	const notify = async (incident: IncidentRow): Promise<void> => {
		if (!mail || !config.smtp) return;
		const name =
			config.monitors.find((monitor) => monitor.id === incident.monitor_id)?.name ?? "Service";
		const resolved = incident.status === "resolved";
		const message = resolved
			? `The incident for ${name} has been resolved.`
			: `An incident for ${name} has been created.\n\n${incident.message}`;
		await Promise.allSettled(
			getActiveSubscribers(db).map(async (subscriber) => {
				const unsubscribe = links.create(subscriber.email, "unsubscribe");
				await mail.send({
					from: config.smtp!.from,
					to: subscriber.email,
					subject: `${resolved ? "Resolved" : "Incident"}: ${name}`,
					text: `${message}\n\n${config.public.basedomain}\n\nUnsubscribe: ${unsubscribe}\n`,
					headers: { "List-Unsubscribe": `<${unsubscribe}>` }
				});
			})
		);
	};
	const runtime = new MonitorRuntime(config, db, notify, options.request);
	app.on("error", () => {
		console.error("HTTP request failed");
	});
	app.use(securityHeaders);
	app.use(async (ctx, next) => {
		try {
			await next();
		} catch (error: unknown) {
			const status =
				typeof error === "object" && error !== null && "status" in error ? error.status : 500;
			ctx.status = typeof status === "number" && status >= 400 && status <= 599 ? status : 500;
			ctx.body = { error: ctx.status < 500 ? "Invalid request" : "Internal server error" };
			if (ctx.status >= 500) app.emit("error", error, ctx);
		}
	});
	if (config.cors.length > 0) {
		app.use(
			cors({
				origin: (ctx) => (config.cors.includes(ctx.get("Origin")) ? ctx.get("Origin") : ""),
				allowMethods: ["GET", "POST"],
				allowHeaders: ["Authorization", "Content-Type"],
				maxAge: 600
			})
		);
	}
	app.use(async (ctx, next) => {
		if (ctx.method === "POST" && /^\/api\/subscribe\/?$/i.test(ctx.path)) {
			if (!config.smtp || !mail) ctx.throw(404, "Subscriptions disabled");
			const limit = subscriptionLimits.consume(ctx.ip);
			if (!limit.allowed) {
				ctx.status = 429;
				ctx.set("Retry-After", String(limit.retryAfter));
				ctx.body = { error: "Too many subscription requests" };
				return;
			}
		}
		await next();
	});
	app.use(bodyParser({ jsonLimit: "16kb", formLimit: "16kb" }));
	const router = new Router();
	router.get("/healthz", (ctx: Context) => {
		ctx.body = { status: "ok" };
	});
	const pushReport = (ctx: Context) => {
		const bearer = /^Bearer ([^\s]+)$/i.exec(ctx.get("Authorization"))?.[1];
		const monitor = tokens.lookup(ctx.method === "POST" ? bearer : ctx.params.token);
		if (ctx.method === "POST" && !monitor) {
			ctx.set("WWW-Authenticate", "Bearer");
			ctx.throw(401, "Invalid authentication");
		}
		if (!monitor) ctx.throw(404, "Monitor not found");
		if (
			ctx.method === "POST" &&
			ctx.params.token &&
			tokens.lookup(ctx.params.token)?.id !== monitor.id
		)
			ctx.throw(404, "Monitor not found");
		const body: unknown = ctx.request.body;
		const input =
			ctx.method === "POST" && typeof body === "object" && body !== null && "status" in body
				? body
				: ctx.query;
		const report = parseReport(input.status, "value" in input ? input.value : undefined);
		if (!report) ctx.throw(400, "Status and value must be valid");
		runtime.receiveReport(monitor.id, report.status, report.value);
		console.info(`Monitor #${monitor.id} callback received`);
		ctx.body = { status: "ok" };
	};
	router.get("/api/monitor/:token", pushReport);
	router.post("/api/monitor/:token", pushReport);
	router.post("/api/monitor", pushReport);
	router.get("/api/overview", (ctx: Context) => {
		const latest = getMonitorsLatestStatus(db);
		const assigned = new Set(config.groups.flatMap((group) => group.monitors));
		ctx.body = {
			public: { ...config.public, subscriptionsEnabled: Boolean(config.smtp) },
			groups: config.groups.filter((group) => group.monitors.length > 0),
			monitors: config.monitors
				.filter((monitor) => monitor.visible && assigned.has(monitor.id))
				.map((monitor) => ({
					id: monitor.id,
					name: monitor.name,
					description: monitor.description,
					uptimeWording: monitor.uptimeWording,
					status: latest[monitor.id] ?? "unknown",
					ts: Date.now()
				}))
		};
	});
	router.get("/api/monitor", (ctx: Context) => {
		const raw = ctx.query.id;
		const id = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
		if (
			typeof raw !== "string" ||
			!/^\d+$/.test(raw) ||
			!Number.isFinite(id) ||
			!Number.isSafeInteger(id) ||
			id <= 0
		)
			ctx.throw(400, "Invalid monitor id");
		if (!config.monitors.some((monitor) => monitor.id === id && monitor.visible))
			ctx.throw(404, "Monitor not found");
		ctx.body = getMonitorStatus(db, id, config.dailyThresholds);
	});
	router.get("/api/incidents", (ctx: Context) => {
		ctx.body = getIncidents(db, 90).map((incident) => ({
			...incident,
			monitor_name: config.monitors.find((monitor) => monitor.id === incident.monitor_id)?.name
		}));
	});
	router.post("/api/subscribe", async (ctx: Context) => {
		if (!config.smtp || !mail) ctx.throw(404, "Subscriptions disabled");
		const body: unknown = ctx.request.body;
		const email =
			typeof body === "object" && body !== null && "email" in body ? body.email : undefined;
		if (typeof email !== "string" || !validator.isEmail(email)) ctx.throw(400, "Invalid email");
		if (addSubscriber(db, email)) {
			const link = links.create(email, "confirm");
			const delivered = await mail.send({
				from: config.smtp.from,
				to: email,
				subject: `Confirm Your ${config.public.companyName} Status Subscription`,
				text: `Confirm your subscription:\n\n${link}\n\nIf you did not request this, ignore this message.`,
				headers: { "List-Unsubscribe": `<${links.create(email, "unsubscribe")}>` }
			});
			if (!delivered) ctx.throw(503, "Mail temporarily unavailable");
		}
		ctx.body = { status: "ok" };
	});
	router.get("/api/confirm-subscription", (ctx: Context) => {
		const { email } = ctx.query;
		if (
			typeof email !== "string" ||
			!validator.isEmail(email) ||
			!links.verify(email, "confirm", ctx.query) ||
			!getSubscriber(db, email)
		) {
			ctx.redirect("/?result=subscribe-error");
			return;
		}
		activateSubscriber(db, email);
		ctx.redirect("/?result=subscribe-success");
	});
	router.get("/api/unsubscribe", (ctx: Context) => {
		const { email } = ctx.query;
		if (
			typeof email !== "string" ||
			!validator.isEmail(email) ||
			!links.verify(email, "unsubscribe", ctx.query)
		) {
			ctx.redirect("/?result=unsubscribe-error");
			return;
		}
		deleteSubscriber(db, email);
		ctx.redirect("/?result=unsubscribe-success");
	});
	app.use(router.routes()).use(router.allowedMethods());
	app.use(serve(path.join(__dirname, "../frontend-vite/dist")));
	return { app, runtime, mail };
}

export function startServer(config = readConfig(), options: { port?: number; host?: string } = {}) {
	const binding = listenOptions();
	const db = initializeDatabase(config.database.path);
	try {
		migrateDatabase(db);
	} catch (error) {
		db.close();
		throw error;
	}
	const service = createApplication(config, db);
	const server = service.app.listen(options.port ?? binding.port, options.host ?? binding.host);
	service.runtime.start();
	const cleanup = () => {
		try {
			cleanupTables(db);
		} catch {
			console.error("Database cleanup failed");
		}
	};
	cleanup();
	const cleanupTimer = setInterval(cleanup, 12 * 3600 * 1000);
	cleanupTimer.unref();
	let closing: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (closing) return closing;
		closing = (async () => {
			clearInterval(cleanupTimer);
			service.mail?.close();
			let deadline: ReturnType<typeof setTimeout> | undefined;
			const stopped = new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			try {
				await Promise.race([
					Promise.allSettled([stopped, service.runtime.stop(), service.mail?.drain()]),
					new Promise<void>((resolve) => {
						deadline = setTimeout(resolve, 10000);
					})
				]);
			} finally {
				clearTimeout(deadline);
				server.closeAllConnections();
				db.close();
			}
		})();
		return closing;
	};
	server.on("error", () => {
		console.error("HTTP listener failed");
		process.exitCode = 1;
		void shutdown().catch(() => {
			console.error("Shutdown failed");
		});
	});
	return { ...service, server, db, shutdown };
}

if (require.main === module) {
	consoleStamp(console, { format: ":date(yyyy-mm-dd HH:MM:ss.l) :label" });
	try {
		const service = startServer();
		installProcessHandlers(service.shutdown);
	} catch (error) {
		console.error("Startup failed:", error instanceof Error ? error.message : "Unknown error");
		process.exitCode = 1;
	}
}

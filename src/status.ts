import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Database } from "better-sqlite3";
import type { Context } from "koa";
import type { Config, MonitorStatus } from "./config";
import {
	getDailyHistory,
	getIncidents,
	getLatestMonitorStatus,
	type HistoryDay,
	type IncidentRow
} from "./database";

export interface SnapshotMonitor {
	id: number;
	name: string;
	description: string;
	uptimeWording: string;
	status: MonitorStatus;
	ts: number;
	history: HistoryDay[];
	uptime: number | null;
	incident: IncidentRow | null;
}
export interface StatusSnapshot {
	public: Config["public"] & { subscriptionsEnabled: boolean };
	groups: Config["groups"];
	monitors: SnapshotMonitor[];
	incidents: IncidentRow[];
	updatedAt: number;
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
	);
}
function svgUrl(svg: string): string {
	return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}
export function renderIndex(template: string, snapshot: StatusSnapshot, json: string): string {
	const title = escapeHtml(`${snapshot.public.companyName} Service Status`);
	const favicon = snapshot.public.favicon
		? `<link rel="icon" type="image/svg+xml" href="${svgUrl(snapshot.public.favicon)}">`
		: "";
	const logo = snapshot.public.logo
		? `<img src="${svgUrl(snapshot.public.logo)}" alt="${escapeHtml(snapshot.public.companyName)} logo">`
		: "";
	// A data block is not executable JavaScript. Escaping '<' prevents </script> breakouts.
	const data = `<script type="application/json" id="status-snapshot">${json.replace(/</g, "\\u003c")}</script>`;
	return template
		.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`)
		.replace(/<\/head>/i, () => favicon + data + "</head>")
		.replace("<!--status-logo-->", () => logo);
}

export function readIndexTemplate(): string | undefined {
	const file = path.join(__dirname, "../frontend-vite/dist/index.html");
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export class StatusCache {
	snapshot!: StatusSnapshot;
	json!: string;
	etag!: string;
	html?: string;
	private bodies!: Record<"identity" | "gzip" | "br", Buffer>;
	constructor(
		private config: Config,
		private db: Database,
		private template?: string
	) {
		this.refresh();
	}
	refresh(): void {
		const now = new Date();
		const monitors = this.config.monitors.filter((monitor) => monitor.visible);
		const ids = new Set(monitors.map((monitor) => monitor.id));
		const incidents = getIncidents(this.db, 90)
			.filter((incident) => ids.has(incident.monitor_id))
			.map((incident) => ({
				...incident,
				monitor_name: monitors.find((monitor) => monitor.id === incident.monitor_id)!.name
			}));
		const snapshot: StatusSnapshot = {
			public: { ...this.config.public, subscriptionsEnabled: Boolean(this.config.smtp) },
			groups: this.config.groups
				.map((group) => ({ ...group, monitors: group.monitors.filter((id) => ids.has(id)) }))
				.filter((group) => group.monitors.length > 0),
			monitors: monitors.map((monitor) => {
				const history = getDailyHistory(this.db, monitor.id, this.config.dailyThresholds, now);
				const known = history.filter((day) => day.uptime !== null);
				return {
					id: monitor.id,
					name: monitor.name,
					description: monitor.description,
					uptimeWording: monitor.uptimeWording,
					status: getLatestMonitorStatus(this.db, monitor.id),
					ts: now.getTime(),
					history,
					uptime: known.length
						? Math.round((known.reduce((sum, day) => sum + day.uptime!, 0) / known.length) * 100) /
							100
						: null,
					incident:
						incidents.find(
							(incident) => incident.monitor_id === monitor.id && incident.status === "active"
						) ?? null
				};
			}),
			incidents,
			updatedAt: now.getTime()
		};
		const json = JSON.stringify(snapshot);
		const identity = Buffer.from(json);
		const bodies = {
			identity,
			gzip: gzipSync(identity),
			br: brotliCompressSync(identity, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
		};
		const html =
			this.template === undefined ? undefined : renderIndex(this.template, snapshot, json);
		// Publish a complete version together; requests never serialize/query/compress the snapshot.
		this.snapshot = snapshot;
		this.json = json;
		this.etag = `W/"${createHash("sha256").update(identity).digest("hex")}"`;
		this.bodies = bodies;
		this.html = html;
	}
	respond(ctx: Context): void {
		ctx.set("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
		ctx.set("ETag", this.etag);
		ctx.vary("Accept-Encoding");
		const matches = ctx
			.get("If-None-Match")
			.split(",")
			.some(
				(tag) =>
					tag.trim() === "*" || tag.trim().replace(/^W\//, "") === this.etag.replace(/^W\//, "")
			);
		if (matches) {
			ctx.status = 304;
			return;
		}
		const encoding = ctx.acceptsEncodings("br", "gzip", "identity");
		if (encoding !== "br" && encoding !== "gzip" && encoding !== "identity") ctx.throw(406);
		ctx.type = "application/json";
		if (encoding !== "identity") ctx.set("Content-Encoding", encoding);
		ctx.body = this.bodies[encoding];
	}
}

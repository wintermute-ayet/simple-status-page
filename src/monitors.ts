import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import type { Database } from "better-sqlite3";
import type { Config, MonitorEntity, MonitorStatus } from "./config";
import { errorDetails, logRedactor, type Redactor } from "./logging";
import {
	addMonitorStatus,
	createIncident,
	initialMonitorState,
	loadMonitorStates,
	resolveIncident,
	saveMonitorState,
	type IncidentRow,
	type MonitorState
} from "./database";

export type HttpRequest = (
	url: string,
	options: AxiosRequestConfig
) => Promise<AxiosResponse<unknown>>;
export type NotifyIncident = (incident: IncidentRow) => Promise<void>;

export class MonitorRuntime {
	private states: Map<number, MonitorState>;
	private inFlight = new Map<number, AbortController>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private pending = new Set<Promise<void>>();
	private stopped = false;
	private started = false;
	private redact: Redactor;
	constructor(
		private config: Config,
		private db: Database,
		private notify: NotifyIncident = async () => {},
		private request: HttpRequest = (url, options) => axios.get<unknown>(url, options),
		private onChange: () => void = () => {}
	) {
		this.redact = logRedactor(config);
		this.states = loadMonitorStates(db);
		for (const monitor of config.monitors) {
			if (!this.states.has(monitor.id))
				this.states.set(monitor.id, initialMonitorState(monitor.id));
		}
	}
	receiveReport(monitorId: number, status: MonitorStatus, value: number): void {
		const next = {
			...this.states.get(monitorId)!,
			last_status: status,
			last_value: value,
			last_report_at: Date.now()
		};
		saveMonitorState(this.db, next);
		this.states.set(monitorId, next);
	}
	private incidentTracker(
		monitor: MonitorEntity,
		state: MonitorState,
		status: MonitorStatus
	): IncidentRow[] {
		state.down_count = status === "down" ? state.down_count + 1 : 0;
		state.degraded_count = status === "degraded" ? state.degraded_count + 1 : 0;
		state.up_count = status === "up" || status === "degraded" ? state.up_count + 1 : 0;
		state.healthy_count = status === "up" ? state.healthy_count + 1 : 0;
		const notifications: IncidentRow[] = [];
		if (!monitor.visible) return notifications;
		for (const type of ["down", "degraded"] as const) {
			const rule = monitor.incidents[type];
			if (!rule || rule.createAfter <= 0 || rule.resolveAfter <= 0) continue;
			if (state[`${type}_count`] >= rule.createAfter) {
				const message =
					rule.message ??
					(type === "down"
						? "Our systems have detected an outage on this service.\nTech support has been notified and is investigating the issue."
						: "Our systems have detected performance degradation on this service.\nTech support has been notified and is investigating the issue.");
				const incident = createIncident(
					this.db,
					monitor.id,
					type,
					message.replace(/<br\s*\/?\s*>/gi, "\n")
				);
				if (incident) notifications.push(incident);
			} else if (
				(type === "degraded" ? state.healthy_count : state.up_count) >= rule.resolveAfter
			) {
				notifications.push(...(resolveIncident(this.db, monitor.id, type) ?? []));
			}
		}
		return notifications;
	}
	private async record(
		monitor: MonitorEntity,
		state: MonitorState,
		status: MonitorStatus,
		value: number
	): Promise<void> {
		const incidents = this.db.transaction(() => {
			const changes = this.incidentTracker(monitor, state, status);
			addMonitorStatus(this.db, monitor.id, status, value, state);
			return changes;
		})();
		this.states.set(monitor.id, state);
		this.onChange();
		console.info(`Monitor #${monitor.id} tracking ${status}`);
		const results = await Promise.allSettled(incidents.map((incident) => this.notify(incident)));
		for (const result of results)
			if (result.status === "rejected")
				console.error("Incident notification failed", errorDetails(result.reason, this.redact));
	}
	async checkApiMonitor(monitor: MonitorEntity): Promise<void> {
		if (this.stopped) return;
		const state = { ...this.states.get(monitor.id)! };
		const fresh =
			state.last_status !== null &&
			Date.now() - state.last_report_at <= monitor.retries * monitor.checkInterval;
		if (fresh) {
			state.retries = 0;
			await this.record(monitor, state, state.last_status!, state.last_value);
			return;
		}
		state.retries = Math.min(state.retries + 1, monitor.retries);
		if (state.retries >= monitor.retries) {
			await this.record(monitor, state, monitor.onMissing, 0);
		} else if (state.last_status !== null) {
			await this.record(monitor, state, state.last_status, state.last_value);
		} else {
			saveMonitorState(this.db, state);
			this.states.set(monitor.id, state);
			this.onChange();
		}
	}
	async checkHTTPMonitor(monitor: MonitorEntity): Promise<void> {
		if (this.stopped || this.inFlight.has(monitor.id)) return;
		const controller = new AbortController();
		this.inFlight.set(monitor.id, controller);
		// eslint-disable-next-line no-useless-assignment -- Share one initialized duration across both request paths.
		let elapsedMs = 0;
		let status: MonitorStatus = "down";
		const startTime = Date.now();
		try {
			try {
				const response = await this.request(monitor.url, {
					timeout: monitor.timeoutDownMs,
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(monitor.timeoutDownMs)]),
					responseType: "text",
					transformResponse: [(data: unknown) => data],
					maxContentLength: 1024 * 1024,
					maxBodyLength: 1024 * 1024,
					maxRedirects: 5,
					headers: {
						"User-Agent": "simple-status-page/1.0",
						Accept: "text/*, application/json, application/xml"
					},
					validateStatus: () => true
				});
				elapsedMs = Date.now() - startTime;
				const contentType = String(response.headers["content-type"] ?? "")
					.split(";")[0]
					.trim()
					.toLowerCase();
				const textBody =
					typeof response.data === "string" &&
					(!contentType ||
						/^(text\/|application\/(?:json|xml|javascript)$|application\/[\w.+-]+\+(?:json|xml)$)/.test(
							contentType
						));
				if (
					monitor.validStatusCodes.includes(response.status) &&
					typeof response.data === "string" &&
					Buffer.byteLength(response.data) <= 1024 * 1024 &&
					(!monitor.compiledRegexp || (textBody && monitor.compiledRegexp.test(response.data)))
				) {
					status = elapsedMs > monitor.timeoutDegradedMs ? "degraded" : "up";
				} else {
					console.warn(`HTTP monitor #${monitor.id} response rejected`, {
						status: response.status,
						message: "Unexpected status or response body"
					});
				}
			} catch (error) {
				elapsedMs = Date.now() - startTime;
				console.warn(
					`HTTP monitor #${monitor.id} request failed`,
					errorDetails(error, this.redact)
				);
			}
			if (this.stopped) return;
			console.info(`HTTP monitor #${monitor.id} completed in ${elapsedMs} ms`);
			const state = {
				...this.states.get(monitor.id)!,
				last_status: status,
				last_value: elapsedMs,
				last_report_at: Date.now()
			};
			state.retries = status === "down" ? Math.min(state.retries + 1, monitor.retries) : 0;
			if (status !== "up") state.healthy_count = 0;
			if (status === "down" && state.retries < monitor.retries) {
				saveMonitorState(this.db, state);
				this.states.set(monitor.id, state);
				this.onChange();
				return;
			}
			await this.record(monitor, state, status, elapsedMs);
		} finally {
			this.inFlight.delete(monitor.id);
		}
	}
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		for (const monitor of this.config.monitors)
			this.schedule(
				monitor,
				monitor.type === "http"
					? Math.floor(
							((((monitor.id % 100) * 37) % 100) / 100) * Math.min(monitor.checkInterval / 10, 1000)
						)
					: monitor.checkInterval
			);
	}
	private schedule(monitor: MonitorEntity, delay: number): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (this.stopped) return;
			const task = (
				monitor.type === "http" ? this.checkHTTPMonitor(monitor) : this.checkApiMonitor(monitor)
			).catch((error) => {
				console.error(`Monitor #${monitor.id} check failed`, errorDetails(error, this.redact));
			});
			this.pending.add(task);
			void task
				.finally(() => {
					this.pending.delete(task);
					if (!this.stopped) this.schedule(monitor, monitor.checkInterval);
				})
				.catch((error) => {
					console.error("Monitor scheduling failed", errorDetails(error, this.redact));
				});
		}, delay);
		this.timers.add(timer);
	}
	async stop(): Promise<void> {
		this.stopped = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		for (const controller of this.inFlight.values()) controller.abort();
		await Promise.allSettled([...this.pending]);
	}
}

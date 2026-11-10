import DatabaseConstructor, { type Database, type Statement } from "better-sqlite3";
import type { DailyThresholds, IncidentType, MonitorStatus } from "./config";

function typedStatement<Parameters extends unknown[], Row>(db: Database, sql: string) {
	return db.prepare<Parameters>(sql) as Omit<Statement<Parameters>, "all" | "get"> & {
		all(...parameters: Parameters): Row[];
		get(...parameters: Parameters): Row | undefined;
	};
}

export function initializeDatabase(dbPath: string): Database {
	return new DatabaseConstructor(dbPath);
}
export interface MonitorState {
	monitor_id: number;
	last_status: MonitorStatus | null;
	last_value: number;
	last_report_at: number;
	retries: number;
	down_count: number;
	degraded_count: number;
	up_count: number;
}
export function initialMonitorState(monitorId: number): MonitorState {
	return {
		monitor_id: monitorId,
		last_status: null,
		last_value: 0,
		last_report_at: 0,
		retries: 0,
		down_count: 0,
		degraded_count: 0,
		up_count: 0
	};
}
export function loadMonitorStates(db: Database): Map<number, MonitorState> {
	const rows = typedStatement<[], MonitorState>(db, "SELECT * FROM monitor_state").all();
	return new Map(rows.map((row) => [row.monitor_id, row]));
}
export function saveMonitorState(db: Database, state: MonitorState): void {
	db.prepare(
		`INSERT INTO monitor_state
		(monitor_id, last_status, last_value, last_report_at, retries, down_count, degraded_count, up_count)
		VALUES (@monitor_id, @last_status, @last_value, @last_report_at, @retries, @down_count, @degraded_count, @up_count)
		ON CONFLICT(monitor_id) DO UPDATE SET last_status=excluded.last_status,
		last_value=excluded.last_value, last_report_at=excluded.last_report_at, retries=excluded.retries,
		down_count=excluded.down_count, degraded_count=excluded.degraded_count, up_count=excluded.up_count`
	).run(state);
}
export function addMonitorStatus(
	db: Database,
	id: number,
	status: MonitorStatus,
	value: number,
	state?: MonitorState
): void {
	const write = () => {
		db.prepare("INSERT INTO monitor_checks (monitor_id, status, val) VALUES (?, ?, ?)").run(
			id,
			status,
			value
		);
		if (state) saveMonitorState(db, state);
	};
	if (state) db.transaction(write)();
	else write();
}
export interface SubscriberRow {
	id: number;
	email: string;
	active: number;
	created: string;
}
export interface IncidentRow {
	id: number;
	monitor_id: number;
	monitor_name?: string;
	type: IncidentType;
	message: string;
	status: "active" | "resolved";
	created: string;
	modified: string;
}
export interface HistoryDay {
	date: string;
	uptime: number | null;
	degraded: number | null;
	status: MonitorStatus;
}
export function getMonitors(db: Database): { id: number; name: string; description: string }[] {
	return typedStatement<[], { id: number; name: string; description: string }>(
		db,
		"SELECT id, name, description FROM monitors WHERE enabled=1"
	).all();
}
export function getMonitorsLatestStatus(db: Database): Record<number, MonitorStatus> {
	const rows = typedStatement<[], { monitor_id: number; status: MonitorStatus }>(
		db,
		`
		SELECT monitor_id, status FROM monitor_checks
		WHERE id IN (SELECT MAX(id) FROM monitor_checks GROUP BY monitor_id)`
	).all();
	return Object.fromEntries(rows.map((row) => [row.monitor_id, row.status]));
}
export function getMonitorStatus(
	db: Database,
	id: number,
	thresholds: DailyThresholds = { down: 0.001, degraded: 0.005 }
): HistoryDay[] {
	const past = new Date();
	past.setUTCDate(past.getUTCDate() - 90);
	const rows = typedStatement<[number, number, number, string], HistoryDay>(
		db,
		`
		SELECT DATE(created) AS date,
		ROUND(AVG(status IN ('up', 'degraded')) * 100, 2) AS uptime,
		ROUND(AVG(status = 'degraded') * 100, 2) AS degraded,
		CASE WHEN AVG(status = 'down') > ? THEN 'down'
		WHEN AVG(status = 'degraded') > ? THEN 'degraded' ELSE 'up' END AS status
		FROM monitor_checks WHERE monitor_id = ? AND DATE(created) >= DATE(?) AND status != 'unknown'
		GROUP BY DATE(created) ORDER BY DATE(created)`
	).all(thresholds.down, thresholds.degraded, id, past.toISOString().slice(0, 10));
	const byDate = new Map(rows.map((row) => [row.date, row]));
	return Array.from({ length: 91 }, (_, index) => {
		const day = new Date(past);
		day.setUTCDate(day.getUTCDate() + index);
		const date = day.toISOString().slice(0, 10);
		return byDate.get(date) ?? { date, uptime: null, degraded: null, status: "unknown" };
	});
}
export function addSubscriber(db: Database, email: string): boolean {
	const existing = getSubscriber(db, email);
	if (existing?.active === 1) return false;
	if (existing) {
		db.prepare("UPDATE subscribers SET created=CURRENT_TIMESTAMP WHERE id=?").run(existing.id);
		return true;
	}
	db.prepare("INSERT INTO subscribers (email) VALUES (?)").run(email);
	return true;
}
export function getSubscriber(db: Database, email: string): SubscriberRow | undefined {
	return typedStatement<[string], SubscriberRow>(db, "SELECT * FROM subscribers WHERE email=?").get(
		email
	);
}
export function getSubscribers(db: Database): SubscriberRow[] {
	return typedStatement<[], SubscriberRow>(db, "SELECT * FROM subscribers").all();
}
export function getActiveSubscribers(db: Database): SubscriberRow[] {
	return typedStatement<[], SubscriberRow>(db, "SELECT * FROM subscribers WHERE active=1").all();
}
export function activateSubscriber(db: Database, email: string): void {
	db.prepare("UPDATE subscribers SET active=1 WHERE email=?").run(email);
}
export function deleteSubscriber(db: Database, email: string): void {
	db.prepare("DELETE FROM subscribers WHERE email=?").run(email);
}
export function createIncident(
	db: Database,
	monitorId: number,
	type: IncidentType,
	message: string
): IncidentRow | undefined {
	const existing = typedStatement<[number, string], IncidentRow>(
		db,
		"SELECT * FROM incidents WHERE monitor_id=? AND type=? AND status='active'"
	).get(monitorId, type);
	if (existing) return undefined;
	const result = db
		.prepare("INSERT INTO incidents (monitor_id, type, message, status) VALUES (?, ?, ?, 'active')")
		.run(monitorId, type, message);
	return typedStatement<[number | bigint], IncidentRow>(
		db,
		"SELECT * FROM incidents WHERE id=?"
	).get(result.lastInsertRowid);
}
export function resolveIncident(
	db: Database,
	monitorId: number,
	type: IncidentType
): IncidentRow[] | undefined {
	const rows = typedStatement<[number, string], IncidentRow>(
		db,
		"SELECT * FROM incidents WHERE monitor_id=? AND type=? AND status='active'"
	).all(monitorId, type);
	if (rows.length === 0) return undefined;
	db.prepare(
		"UPDATE incidents SET status='resolved', modified=CURRENT_TIMESTAMP WHERE monitor_id=? AND type=? AND status='active'"
	).run(monitorId, type);
	return rows.map(
		(row) =>
			typedStatement<[number], IncidentRow>(db, "SELECT * FROM incidents WHERE id=?").get(row.id)!
	);
}
export function getIncidents(db: Database, days: number): IncidentRow[] {
	const start = new Date();
	start.setUTCDate(start.getUTCDate() - days);
	return typedStatement<[string], IncidentRow>(
		db,
		"SELECT * FROM incidents WHERE status='active' OR created>=? ORDER BY id DESC"
	).all(
		start
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "")
	);
}
export function cleanupTables(db: Database): void {
	db.prepare("DELETE FROM subscribers WHERE active=0 AND created<DATETIME('now', '-14 day')").run();
	db.prepare("DELETE FROM monitor_checks WHERE created<DATETIME('now', '-91 day')").run();
}

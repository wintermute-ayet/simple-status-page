import { rmSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import migrateDatabase from "../src/database-migrations";
import {
	addMonitorStatus,
	cleanupTables,
	getDailyHistory,
	getMonitorStatus,
	initialMonitorState,
	initializeDatabase
} from "../src/database";
import { temporaryDirectory } from "./helpers";

let db: Database;
let directory: string | undefined;
beforeEach(() => {
	db = initializeDatabase(":memory:");
	migrateDatabase(db);
});
afterEach(() => {
	db.close();
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});
const thresholds = { down: 0.001, degraded: 0.005 };

describe("daily roll-up", () => {
	it("counts known statuses per monitor/day and excludes unknown samples", () => {
		for (const status of ["up", "up", "degraded", "down", "unknown"] as const)
			addMonitorStatus(db, 1, status, 0);
		addMonitorStatus(db, 2, "down", 0);
		addMonitorStatus(db, 3, "unknown", 0);
		expect(
			db
				.prepare("SELECT monitor_id, up, degraded, down FROM monitor_daily ORDER BY monitor_id")
				.all()
		).toEqual([
			{ monitor_id: 1, up: 2, degraded: 1, down: 1 },
			{ monitor_id: 2, up: 0, degraded: 0, down: 1 }
		]);
		expect(db.prepare("SELECT COUNT(*) AS count FROM monitor_checks").get()).toEqual({ count: 7 });
		const history = getDailyHistory(db, 1, thresholds);
		expect(history).toEqual(getMonitorStatus(db, 1, thresholds));
		expect(history.filter((day) => day.uptime !== null)).toEqual([
			expect.objectContaining({ uptime: 75, degraded: 25, status: "down" })
		]);
		expect(getDailyHistory(db, 1, { down: 0.5, degraded: 0.2 }).at(-1)?.status).toBe("degraded");
		expect(
			getDailyHistory(db, 3, thresholds).every(
				(day) => day.uptime === null && day.status === "unknown"
			)
		).toBe(true);
	});
	it("rolls back raw checks and state when the roll-up write fails", () => {
		db.exec(
			"CREATE TRIGGER reject_daily BEFORE INSERT ON monitor_daily BEGIN SELECT RAISE(ABORT, 'daily failed'); END"
		);
		expect(() => addMonitorStatus(db, 1, "up", 4, initialMonitorState(1))).toThrow("daily failed");
		for (const table of ["monitor_checks", "monitor_daily", "monitor_state"])
			expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
	});
	it("represents zero-count and absent days with null uptime over 91 UTC dates", () => {
		db.exec("INSERT INTO monitor_daily VALUES (1, DATE('now'), 0, 0, 0)");
		const history = getDailyHistory(db, 1, thresholds);
		expect(history).toHaveLength(91);
		expect(new Set(history.map((day) => day.date)).size).toBe(91);
		expect(
			history.every(
				(day) => day.uptime === null && day.degraded === null && day.status === "unknown"
			)
		).toBe(true);
	});
});

describe("migration 4 backfill", () => {
	it("backfills the inclusive 91-day range once, safely replaces conflicts, and can re-run", () => {
		db.exec(`DELETE FROM migrations WHERE id=4; DROP TABLE monitor_daily;
			INSERT INTO monitor_checks (monitor_id, status, created) VALUES
			(1,'up',DATETIME('now','-90 days','start of day')),
			(1,'down',DATETIME('now','-90 days','start of day','+1 second')),
			(1,'unknown',CURRENT_TIMESTAMP), (1,'degraded',CURRENT_TIMESTAMP),
			(2,'up',CURRENT_TIMESTAMP), (3,'unknown',CURRENT_TIMESTAMP),
			(1,'down',DATETIME('now','-91 days')), (1,'down',DATETIME('now','+1 day'));`);
		migrateDatabase(db);
		expect(
			db
				.prepare(
					"SELECT monitor_id, up, degraded, down FROM monitor_daily ORDER BY monitor_id, day"
				)
				.all()
		).toEqual([
			{ monitor_id: 1, up: 1, degraded: 0, down: 1 },
			{ monitor_id: 1, up: 0, degraded: 1, down: 0 },
			{ monitor_id: 2, up: 1, degraded: 0, down: 0 }
		]);
		addMonitorStatus(db, 1, "up", 3);
		const before = db.prepare("SELECT * FROM monitor_daily ORDER BY monitor_id, day").all();
		migrateDatabase(db);
		expect(db.prepare("SELECT * FROM monitor_daily ORDER BY monitor_id, day").all()).toEqual(
			before
		);
		db.exec("DELETE FROM migrations WHERE id=4");
		migrateDatabase(db);
		expect(db.prepare("SELECT * FROM monitor_daily ORDER BY monitor_id, day").all()).toEqual(
			before
		);
		expect(db.prepare("SELECT COUNT(*) AS count FROM monitor_checks").get()).toEqual({ count: 9 });
	});
	it("uses an indexed timestamp range rather than filtering the entire table through DATE", () => {
		const plan = db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT monitor_id, DATE(created), SUM(status='up')
			FROM monitor_checks INDEXED BY idx_monitor_checks_created
			WHERE created >= DATE('now','-90 days') AND created < DATE('now','+1 day')
			GROUP BY monitor_id, DATE(created)`
			)
			.all();
		expect(JSON.stringify(plan)).toContain(
			"SEARCH monitor_checks USING INDEX idx_monitor_checks_created"
		);
	});
});

describe("SQLite tuning and retention", () => {
	it("enables WAL, NORMAL synchronization, busy timeout and incremental auto-vacuum on new files", () => {
		db.close();
		directory = temporaryDirectory("sqlite-tuning");
		db = initializeDatabase(`${directory}/test.sqlite`);
		migrateDatabase(db);
		expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
		expect(db.pragma("synchronous", { simple: true })).toBe(1);
		expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
		expect(db.pragma("auto_vacuum", { simple: true })).toBe(2);
		expect(
			(db.pragma("index_info(idx_monitor_checks_monitor_created)") as { name: string }[]).map(
				(row) => row.name
			)
		).toEqual(["monitor_id", "created"]);
	});
	it("keeps trimming raw checks and old daily rows before incremental vacuum", () => {
		addMonitorStatus(db, 1, "up", 1);
		db.exec(`INSERT INTO monitor_checks (monitor_id,status,created) VALUES (1,'down',DATETIME('now','-92 days'));
			INSERT INTO monitor_daily VALUES (1,DATE('now','-91 days'),0,0,1);
			INSERT INTO subscribers (email, active, created) VALUES ('test-invalid-address',0,DATETIME('now','-15 days'));`);
		cleanupTables(db);
		expect(db.prepare("SELECT status FROM monitor_checks").all()).toEqual([{ status: "up" }]);
		expect(db.prepare("SELECT up FROM monitor_daily").all()).toEqual([{ up: 1 }]);
		expect(db.prepare("SELECT * FROM subscribers").all()).toEqual([]);
	});
});

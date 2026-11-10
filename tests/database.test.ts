import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import migrateDatabase from "../src/database-migrations";
import {
	addMonitorStatus,
	getMonitorStatus,
	getMonitorsLatestStatus,
	initialMonitorState,
	initializeDatabase
} from "../src/database";

let db: Database;

beforeEach(() => {
	db = initializeDatabase(":memory:");
});

afterEach(() => {
	db.close();
});

describe("database migrations", () => {
	it("creates the schema and indexes for a new database", () => {
		migrateDatabase(db);
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
		expect(tables).toEqual(
			expect.arrayContaining([
				{ name: "migrations" },
				{ name: "monitors" },
				{ name: "monitor_checks" },
				{ name: "subscribers" },
				{ name: "incidents" },
				{ name: "monitor_state" },
				{ name: "monitor_daily" }
			])
		);
		expect(db.prepare("SELECT id FROM migrations ORDER BY id").all()).toEqual([
			{ id: 1 },
			{ id: 2 },
			{ id: 3 },
			{ id: 4 }
		]);
		expect(db.prepare("PRAGMA index_info(idx_monitor_checks_monitor_id)").all()).toEqual([
			{ seqno: 0, cid: 1, name: "monitor_id" }
		]);
		expect(db.prepare("PRAGMA index_info(idx_monitor_checks_created)").all()).toEqual([
			{ seqno: 0, cid: 2, name: "created" }
		]);
	});

	it("can run again without reapplying migrations or losing checks", () => {
		migrateDatabase(db);
		addMonitorStatus(db, 1, "up", 17);
		migrateDatabase(db);
		expect(db.prepare("SELECT monitor_id, status, val FROM monitor_checks").all()).toEqual([
			{ monitor_id: 1, status: "up", val: 17 }
		]);
		expect(db.prepare("SELECT COUNT(*) AS count FROM migrations").get()).toEqual({ count: 4 });
	});
	it("preserves legacy raw checks and extends them to accept unknown", () => {
		db.exec(`CREATE TABLE migrations (id INTEGER PRIMARY KEY); INSERT INTO migrations VALUES (1), (2);
			CREATE TABLE monitor_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER,
			created DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT CHECK(status IN ('up','degraded','down')), val INTEGER);
			INSERT INTO monitor_checks VALUES (7,1,'2024-01-01 12:00:00','up',17);`);
		migrateDatabase(db);
		expect(db.prepare("SELECT id, status, val FROM monitor_checks").all()).toEqual([
			{ id: 7, status: "up", val: 17 }
		]);
		addMonitorStatus(db, 1, "unknown", 0);
		expect(db.prepare("SELECT MAX(id) AS id FROM monitor_checks").get()).toEqual({ id: 8 });
		expect(db.prepare("SELECT last_status, last_value FROM monitor_state").get()).toEqual({
			last_status: "up",
			last_value: 17
		});
	});
	it("rolls back a check if its state update fails", () => {
		migrateDatabase(db);
		db.exec(
			"CREATE TRIGGER fail_state BEFORE INSERT ON monitor_state BEGIN SELECT RAISE(ABORT, 'state failed'); END"
		);
		expect(() => addMonitorStatus(db, 1, "up", 7, initialMonitorState(1))).toThrow("state failed");
		expect(db.prepare("SELECT * FROM monitor_checks").all()).toEqual([]);
		expect(db.prepare("SELECT * FROM monitor_daily").all()).toEqual([]);
	});
});

describe("getMonitorStatus", () => {
	it("returns 91 unknown days when a monitor has no checks", () => {
		migrateDatabase(db);
		const history = getMonitorStatus(db, 1);
		expect(history).toHaveLength(91);
		expect(history.every((day) => day.status === "unknown")).toBe(true);
		expect(history.every((day) => day.uptime === null)).toBe(true);
	});

	it("includes the requested monitor's checks and leaves other days unknown", () => {
		migrateDatabase(db);
		addMonitorStatus(db, 1, "up", 17);
		addMonitorStatus(db, 2, "down", 0);
		// Read the date from SQLite so the test also works near midnight and in any timezone.
		const { day } = db.prepare("SELECT DATE(created) AS day FROM monitor_checks LIMIT 1").get() as {
			day: string;
		};
		const history = getMonitorStatus(db, 1);
		expect(history.find((entry) => entry.date === day)).toEqual({
			date: day,
			uptime: 100,
			degraded: 0,
			status: "up"
		});
		expect(history.filter((entry) => entry.status === "unknown")).toHaveLength(90);
	});
	it("excludes no-data checks from uptime and applies configurable daily thresholds", () => {
		migrateDatabase(db);
		addMonitorStatus(db, 1, "up", 1);
		addMonitorStatus(db, 1, "unknown", 0);
		addMonitorStatus(db, 1, "down", 0);
		const history = getMonitorStatus(db, 1);
		const day = history.find((entry) => entry.status !== "unknown")!;
		expect(day).toMatchObject({ uptime: 50, status: "down" });
		expect(
			getMonitorStatus(db, 1, { down: 0.6, degraded: 0.6 }).find((entry) => entry.date === day.date)
				?.status
		).toBe("up");
	});
	it("selects the last inserted status even when timestamps tie or data is old", () => {
		migrateDatabase(db);
		addMonitorStatus(db, 1, "up", 1);
		addMonitorStatus(db, 1, "down", 0);
		db.exec("UPDATE monitor_checks SET created='2024-01-01 12:00:00'");
		expect(getMonitorsLatestStatus(db)).toEqual({ 1: "down" });
	});
});

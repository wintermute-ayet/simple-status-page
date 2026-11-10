import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import migrateDatabase from "../src/database-migrations";
import { addMonitorStatus, getMonitorStatus, initializeDatabase } from "../src/database";

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
				{ name: "incidents" }
			])
		);
		expect(db.prepare("SELECT id FROM migrations ORDER BY id").all()).toEqual([
			{ id: 1 },
			{ id: 2 }
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
		expect(db.prepare("SELECT COUNT(*) AS count FROM migrations").get()).toEqual({ count: 2 });
	});
});

describe("getMonitorStatus", () => {
	it("returns 91 unknown days when a monitor has no checks", () => {
		migrateDatabase(db);
		const history = getMonitorStatus(db, 1);
		expect(history).toHaveLength(91);
		expect(history.every((day) => day.status === "unknown")).toBe(true);
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
});

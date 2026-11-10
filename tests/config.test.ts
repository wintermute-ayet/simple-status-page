import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config";

describe("readConfig", () => {
	it("reads and parses YAML from the requested path", () => {
		const read = vi.spyOn(fs, "readFileSync").mockReturnValue(
			`public:
  companyName: Example
monitors: []
groups: []
database:
  path: ':memory:'
`
		);
		expect(readConfig("config.test.yml")).toEqual({
			public: { companyName: "Example" },
			monitors: [],
			groups: [],
			database: { path: ":memory:" }
		});
		expect(read).toHaveBeenCalledWith("config.test.yml", "utf8");
	});

	it("reports malformed YAML instead of silently returning a config", () => {
		vi.spyOn(fs, "readFileSync").mockReturnValue("monitors: [");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => readConfig("config.test.yaml")).toThrow();
		expect(log).toHaveBeenCalledWith("Failed to read configuration file:", expect.any(Error));
	});

	it("preserves filesystem errors for the caller", () => {
		const error = new Error("Missing test config");
		vi.spyOn(fs, "readFileSync").mockImplementation(() => {
			throw error;
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => readConfig("config.test.yaml")).toThrow(error);
	});
});

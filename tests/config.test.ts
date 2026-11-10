import fs from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it, vi } from "vitest";
import { readConfig, resolveConfigPath, validateConfig } from "../src/config";
import { makeConfig, rawConfig, testToken } from "./helpers";

describe("configuration validation", () => {
	it("normalizes defaults and allows omitted SMTP", () => {
		const config = makeConfig();
		expect(config.smtp).toBeUndefined();
		expect(config.monitors[0].onMissing).toBe("down");
		expect(config.dailyThresholds).toEqual({ down: 0.001, degraded: 0.005 });
		expect(config.cors).toEqual([]);
		expect(config.proxy).toBe(false);
	});
	it("requires at least 32 salt characters only when SMTP is configured", () => {
		const smtp = { host: "smtp.example.com", from: "test-sender", port: 587 };
		for (const salt of [undefined, "", "x".repeat(31)])
			expect(() => makeConfig({}, { smtp, salt })).toThrow(/salt/);
		expect(makeConfig({}, { smtp, salt: "x".repeat(32) }).salt).toHaveLength(32);
		expect(makeConfig({}, { salt: "" }).salt).toBe("");
	});
	it("requires check intervals of at least one second", () => {
		expect(() => makeConfig({ checkInterval: 999 })).toThrow(/1000/);
		expect(makeConfig({ checkInterval: 1000 }).monitors[0].checkInterval).toBe(1000);
	});
	it("accepts explicit CORS origins and proxy trust only", () => {
		expect(makeConfig({}, { cors: ["https://EXAMPLE.com/"], proxy: true })).toMatchObject({
			cors: ["https://example.com"],
			proxy: true
		});
		for (const cors of [
			"*",
			["*"],
			["null"],
			["https://example.com/path"],
			["https://example.com/?query=1"],
			["https://example.com/#fragment"]
		])
			expect(() => makeConfig({}, { cors })).toThrow();
		expect(() => makeConfig({}, { proxy: "true" })).toThrow(/boolean/);
	});
	it("rejects duplicate monitor ids and API tokens without echoing token values", () => {
		const monitor = rawConfig().monitors[0];
		expect(() => validateConfig(rawConfig({}, { monitors: [monitor, monitor] }))).toThrow(/unique/);
		try {
			validateConfig(rawConfig({}, { monitors: [monitor, { ...monitor, id: 2 }] }));
			throw new Error("Expected validation failure");
		} catch (error) {
			expect((error as Error).message).toMatch(/tokens must be unique/);
			expect((error as Error).message).not.toContain(testToken);
		}
	});
	it("validates rotated token uniqueness and minimum length", () => {
		expect(() => makeConfig({ tokens: [testToken] })).toThrow(/unique/);
		expect(() => makeConfig({ tokens: ["short"] })).toThrow(/16/);
		expect(() => makeConfig({ uuid: "short" })).toThrow(/16/);
	});
	it("rejects missing group members", () => {
		expect(() => makeConfig({}, { groups: [{ name: "Missing", monitors: [2] }] })).toThrow(
			/missing monitor/
		);
	});
	it("rejects unknown keys at every configuration boundary", () => {
		for (const root of [
			{ typo: true },
			{ public: { typo: true } },
			{ database: { path: ":memory:", typo: true } },
			{ dailyThresholds: { typo: true } },
			{ groups: [{ name: "Group", typo: true }] }
		]) {
			expect(() => makeConfig({}, root)).toThrow(/Unknown configuration key/);
		}
		expect(() => makeConfig({ typo: true })).toThrow(/Unknown configuration key/);
		expect(() => makeConfig({ incidents: { down: { createAfter: 1, typo: true } } })).toThrow(
			/Unknown configuration key/
		);
		expect(() => makeConfig({}, { smtp: { typo: true } })).toThrow(/Unknown configuration key/);
	});
	it("rejects invalid numbers, intervals, thresholds and missing-data policies", () => {
		for (const monitor of [
			{ id: -1 },
			{ checkInterval: 0 },
			{ retries: 0 },
			{ retries: 1.5 },
			{ timeoutDownMs: Infinity },
			{ onMissing: "up" },
			{ validStatusCodes: [700] }
		]) {
			expect(() => makeConfig(monitor)).toThrow();
		}
		expect(() => makeConfig({}, { dailyThresholds: { down: 2 } })).toThrow(/fractions/);
	});
	it("compiles regular expressions and rejects invalid patterns at startup", () => {
		expect(makeConfig({ regexp: "healthy" }).monitors[0].compiledRegexp?.test("healthy")).toBe(
			true
		);
		expect(() => makeConfig({ regexp: "[" })).toThrow(/regular expression/);
	});
	it("supports the deprecated timeout alias with a warning and canonical precedence", () => {
		const warn = vi.fn();
		const config = validateConfig(
			rawConfig({ timeoutDegradationMs: 40, timeoutDownMs: 100 }),
			warn
		);
		expect(config.monitors[0].timeoutDegradedMs).toBe(40);
		expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("deprecated"));
		expect(
			validateConfig(
				rawConfig({ timeoutDegradationMs: 40, timeoutDegradedMs: 60, timeoutDownMs: 100 }),
				warn
			).monitors[0].timeoutDegradedMs
		).toBe(60);
	});
	it("reads the production example successfully", () => {
		expect(readConfig("data/config.example.yml").monitors).toHaveLength(2);
	});
});

describe("config file loading", () => {
	it("reads and validates YAML from the requested path", () => {
		const read = vi.spyOn(fs, "readFileSync").mockReturnValue(yaml.dump(rawConfig()));
		expect(readConfig("config.test.yml").monitors[0].uuid).toBe(testToken);
		expect(read).toHaveBeenCalledWith("config.test.yml", "utf8");
	});
	it("does not expose YAML content or filesystem errors in startup errors", () => {
		vi.spyOn(fs, "readFileSync").mockReturnValue("private-test-input: [");
		expect(() => readConfig("config.test.yaml")).toThrow(
			"Unable to read or parse configuration YAML"
		);
		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw new Error("Private filesystem detail");
		});
		expect(() => readConfig("config.test.yaml")).toThrow(
			"Unable to read or parse configuration YAML"
		);
	});
	it("prefers CONFIG_PATH, then yaml, then yml", () => {
		const exists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
		expect(resolveConfigPath("custom.yml")).toBe("custom.yml");
		expect(exists).not.toHaveBeenCalled();
		expect(resolveConfigPath("")).toBe("data/config.yaml");
		exists.mockReturnValue(false);
		expect(resolveConfigPath("")).toBe("data/config.yml");
	});
});

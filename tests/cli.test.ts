import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import Koa from "koa";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { close, listen, rawConfig, temporaryDirectory } from "./helpers";

let directory: string;
let listener: Awaited<ReturnType<typeof listen>> | undefined;
beforeEach(() => {
	directory = temporaryDirectory("cli-test");
});
afterEach(async () => {
	if (listener) await close(listener.server);
	listener = undefined;
	rmSync(directory, { recursive: true, force: true });
});
function configFile(config: unknown = rawConfig()): string {
	const file = `${directory}/config.yml`;
	writeFileSync(file, yaml.dump(config));
	return file;
}
function cli(
	args: string[],
	configPath = ""
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["dist/cli.js", ...args], {
			env: { ...process.env, CONFIG_PATH: configPath }
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

describe("compiled CLI exit codes", () => {
	it("validates an explicit path without opening the configured database", async () => {
		const dbPath = `${directory}/uncreated/database.sqlite`;
		const result = await cli([
			"check-config",
			configFile(rawConfig({}, { database: { path: dbPath } }))
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Configuration valid");
		expect(existsSync(dbPath)).toBe(false);
	});
	it("uses CONFIG_PATH and reports malformed or missing configuration without exposing YAML", async () => {
		expect((await cli(["check-config"], configFile())).code).toBe(0);
		const invalid = configFile();
		writeFileSync(invalid, "test-private-input: [");
		const result = await cli(["check-config", invalid]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unable to read or parse configuration YAML");
		expect(result.stderr).not.toContain("test-private-input");
		expect((await cli(["check-config", `${directory}/missing.yml`])).code).toBe(1);
		const badIds = configFile(rawConfig({ id: -1 }));
		expect((await cli(["check-config", badIds])).stderr).toContain("monitors[0].id");
	});
	it("returns usage errors and handles a config without HTTP monitors", async () => {
		for (const args of [[], ["unknown"], ["check-config", "first.yml", "extra"]]) {
			const result = await cli(args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Usage:");
		}
		const result = await cli(["check-monitors", configFile()]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("No HTTP monitors");
	});
	it("checks every HTTP monitor once, prints results, and fails if any is down", async () => {
		const calls: string[] = [];
		const app = new Koa();
		app.use((ctx) => {
			calls.push(ctx.path);
			ctx.type = "text";
			ctx.body = "healthy";
			ctx.status = ctx.path === "/bad" ? 503 : 200;
		});
		listener = await listen(app);
		const first = rawConfig({
			type: "http",
			name: "Healthy service",
			url: listener.url + "/ok",
			timeoutDegradedMs: 500,
			timeoutDownMs: 1000,
			retries: 10
		}).monitors[0];
		const second = { ...first, id: 2, name: "Failing service", url: listener.url + "/bad" };
		const api = { ...rawConfig().monitors[0], id: 3 };
		const path = configFile(
			rawConfig(
				{},
				{ monitors: [first, second, api], database: { path: `${directory}/must-not-exist.sqlite` } }
			)
		);
		const result = await cli(["check-monitors", path]);
		expect(result.code).toBe(1);
		expect(calls).toEqual(["/ok", "/bad"]);
		for (const value of [
			"id",
			"name",
			"status",
			"elapsed",
			"Healthy service",
			"Failing service",
			"up",
			"down"
		])
			expect(result.stdout).toContain(value);
		expect(result.stdout).not.toContain(api.uuid);
		expect(existsSync(`${directory}/must-not-exist.sqlite`)).toBe(false);
		calls.length = 0;
		const healthy = await cli(["check-monitors", configFile(rawConfig({}, { monitors: [first] }))]);
		expect(healthy.code).toBe(0);
		expect(calls).toEqual(["/ok"]);
	});
	it("returns nonzero on timeout using the normal HTTP safeguards", async () => {
		const app = new Koa();
		app.use(async (ctx) => {
			await new Promise((resolve) => setTimeout(resolve, 150));
			ctx.body = "late";
		});
		listener = await listen(app);
		const result = await cli([
			"check-monitors",
			configFile(
				rawConfig({ type: "http", url: listener.url, timeoutDownMs: 30, timeoutDegradedMs: 20 })
			)
		]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("down");
	});
});

import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { installProcessHandlers } from "../src/lifecycle";
import { startServer } from "../src/server";
import { makeConfig } from "./helpers";

const initialExitCode = process.exitCode;
let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	process.exitCode = initialExitCode;
});

it("handles both stop signals once", async () => {
	const registrations = vi.spyOn(process, "on");
	const shutdown = vi.fn<() => Promise<void>>().mockResolvedValue();
	dispose = installProcessHandlers(shutdown);
	for (const name of ["SIGTERM", "SIGINT"]) {
		const handler = registrations.mock.calls.find(([event]) => event === name)![1];
		handler();
	}
	await Promise.resolve();
	expect(shutdown).toHaveBeenCalledTimes(1);
});
it.each(["unhandledRejection", "uncaughtException"])(
	"logs %s and shuts down with a failing exit code",
	async (name) => {
		const registrations = vi.spyOn(process, "on");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const shutdown = vi.fn<() => Promise<void>>().mockResolvedValue();
		dispose = installProcessHandlers(shutdown);
		const handler = registrations.mock.calls.find(([event]) => event === name)![1];
		handler();
		await Promise.resolve();
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	}
);
it("closes the listener and SQLite during graceful shutdown", async () => {
	const service = startServer(makeConfig(), { port: 0, host: "127.0.0.1" });
	await once(service.server, "listening");
	await service.shutdown();
	await service.shutdown();
	expect(service.server.listening).toBe(false);
	expect(service.db.open).toBe(false);
});

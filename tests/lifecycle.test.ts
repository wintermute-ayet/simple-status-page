import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { installProcessHandlers } from "../src/lifecycle";
import { startServer } from "../src/server";
import { makeConfig } from "./helpers";
import { logRedactor } from "../src/logging";

const initialExitCode = process.exitCode;
let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	process.exitCode = initialExitCode;
	vi.useRealTimers();
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
		handler(new Error("Test fatal reason"));
		await Promise.resolve();
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalled();
		expect(JSON.stringify(log.mock.calls)).toContain("Test fatal reason");
		expect(JSON.stringify(log.mock.calls)).toContain("stack");
		expect(process.exitCode).toBe(1);
	}
);
it("arms one unref'd fatal-exit deadline and exits even if shutdown hangs", async () => {
	vi.useFakeTimers();
	const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	const timers = vi.spyOn(globalThis, "setTimeout");
	const registrations = vi.spyOn(process, "on");
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const config = makeConfig();
	const shutdown = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => {}));
	dispose = installProcessHandlers(shutdown, logRedactor(config));
	const fatal = registrations.mock.calls.find(([event]) => event === "unhandledRejection")![1];
	fatal(new Error(`Callback /api/monitor/${config.monitors[0].uuid}`));
	fatal("Second fatal reason");
	expect(shutdown).toHaveBeenCalledTimes(1);
	expect(timers).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 15000);
	expect(timers.mock.results[0].value.hasRef()).toBe(false);
	await vi.advanceTimersByTimeAsync(14999);
	expect(exit).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(exit).toHaveBeenCalledExactlyOnceWith(1);
	expect(JSON.stringify(log.mock.calls)).not.toContain(config.monitors[0].uuid);
});
it("does not arm a fatal deadline for an ordinary stop signal", async () => {
	vi.useFakeTimers();
	const registrations = vi.spyOn(process, "on");
	dispose = installProcessHandlers(() => Promise.resolve());
	registrations.mock.calls.find(([event]) => event === "SIGTERM")![1]();
	await Promise.resolve();
	expect(vi.getTimerCount()).toBe(0);
});
it("closes the listener and SQLite during graceful shutdown", async () => {
	const service = startServer(makeConfig(), { port: 0, host: "127.0.0.1" });
	await once(service.server, "listening");
	await service.shutdown();
	await service.shutdown();
	expect(service.server.listening).toBe(false);
	expect(service.db.open).toBe(false);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailQueue, smtpOptions, type MailTransport } from "../src/mail";
import { testEmail } from "./helpers";

let queue: MailQueue;
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
	queue?.close();
	await queue?.drain();
	vi.useRealTimers();
});
function transport(): MailTransport {
	return { sendMail: vi.fn<MailTransport["sendMail"]>(), close: vi.fn() };
}
const message = { from: testEmail, to: testEmail, subject: "Test", text: "Test message" };

describe("bounded mail delivery", () => {
	it("catches failures and stops after two retries", async () => {
		const smtp = transport();
		vi.mocked(smtp.sendMail).mockRejectedValue(new Error("SMTP unavailable"));
		queue = new MailQueue(smtp);
		expect(await queue.send(message)).toBe(false);
		expect(smtp.sendMail).toHaveBeenCalledTimes(3);
	});
	it("recovers on a later attempt", async () => {
		const smtp = transport();
		vi.mocked(smtp.sendMail)
			.mockRejectedValueOnce(new Error("Temporary"))
			.mockResolvedValueOnce({});
		queue = new MailQueue(smtp);
		expect(await queue.send(message)).toBe(true);
		expect(smtp.sendMail).toHaveBeenCalledTimes(2);
	});
	it("times out hanging sends and continues with a bounded number of attempts", async () => {
		const smtp = transport();
		vi.mocked(smtp.sendMail).mockImplementation(() => new Promise(() => {}));
		queue = new MailQueue(smtp, 10, 2);
		const delivered = queue.send(message);
		await vi.advanceTimersByTimeAsync(31);
		expect(await delivered).toBe(false);
		expect(smtp.sendMail).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("serializes deliveries and cancels pending work on shutdown", async () => {
		const smtp = transport();
		vi.mocked(smtp.sendMail).mockImplementation(() => new Promise(() => {}));
		queue = new MailQueue(smtp);
		const first = queue.send(message);
		const second = queue.send(message);
		await vi.advanceTimersByTimeAsync(0);
		expect(smtp.sendMail).toHaveBeenCalledTimes(1);
		queue.close();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
		await queue.drain();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("rejects excess queued messages without opening more connections", async () => {
		const smtp = transport();
		vi.mocked(smtp.sendMail).mockImplementation(() => new Promise(() => {}));
		queue = new MailQueue(smtp);
		const tasks = Array.from({ length: 100 }, () => queue.send(message));
		expect(await queue.send(message)).toBe(false);
		queue.close();
		await Promise.all(tasks);
		expect(smtp.sendMail).toHaveBeenCalledTimes(1);
	});
});

it.each([25, 465, 587])("sets SMTP TLS and connection deadlines for port %i", (port) => {
	const options = smtpOptions({
		host: "localhost",
		from: testEmail,
		username: "",
		password: "",
		port
	});
	expect(options.secure).toBe(port === 465);
	expect(options.requireTLS).toBe(port === 587);
	expect(options.connectionTimeout).toBe(5000);
	expect(options.socketTimeout).toBe(5000);
});

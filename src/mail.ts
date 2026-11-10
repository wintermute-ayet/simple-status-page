import nodemailer, { type SendMailOptions } from "nodemailer";
import type { SmtpConfig } from "./config";

export interface MailTransport {
	sendMail(options: SendMailOptions): Promise<unknown>;
	close(): void;
}

export function smtpOptions(smtp: SmtpConfig) {
	return {
		host: smtp.host,
		port: smtp.port,
		secure: smtp.port === 465,
		requireTLS: smtp.port === 587,
		connectionTimeout: 5000,
		greetingTimeout: 5000,
		socketTimeout: 5000,
		auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
		disableFileAccess: true,
		disableUrlAccess: true
	};
}

export class MailQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	private closed = false;
	private cancelAttempt?: () => void;
	constructor(
		private transport: MailTransport,
		private timeoutMs = 10000,
		private retries = 2,
		private retryDelayMs = 250
	) {}

	send(message: SendMailOptions): Promise<boolean> {
		if (this.closed || this.pending >= 100) {
			console.warn("Mail queue unavailable");
			return Promise.resolve(false);
		}
		this.pending++;
		const task = this.tail
			.then(() => this.deliver(message))
			.catch(() => {
				console.error("Mail queue failed");
				return false;
			});
		this.tail = task.then(() => {
			this.pending--;
		});
		return task;
	}
	private async deliver(message: SendMailOptions): Promise<boolean> {
		for (let attempt = 0; attempt <= this.retries && !this.closed; attempt++) {
			if (attempt > 0) {
				await this.waitForRetry(Math.min(this.retryDelayMs * 2 ** (attempt - 1), 2000));
				if (this.closed) break;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const deadline = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Mail timeout")), this.timeoutMs);
					this.cancelAttempt = () => reject(new Error("Mail queue closed"));
				});
				await Promise.race([this.transport.sendMail(message), deadline]);
				return true;
			} catch {
				console.warn(`Mail delivery attempt ${attempt + 1} failed`);
			} finally {
				clearTimeout(timer);
				this.cancelAttempt = undefined;
			}
		}
		return false;
	}
	private waitForRetry(delay: number): Promise<void> {
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.cancelAttempt = undefined;
				resolve();
			};
			const timer = setTimeout(finish, delay);
			this.cancelAttempt = finish;
		});
	}
	async drain(): Promise<void> {
		await this.tail;
	}
	close(): void {
		this.closed = true;
		this.cancelAttempt?.();
		this.transport.close();
	}
}

export function createMailQueue(smtp: SmtpConfig | undefined): MailQueue | undefined {
	return smtp ? new MailQueue(nodemailer.createTransport(smtpOptions(smtp))) : undefined;
}

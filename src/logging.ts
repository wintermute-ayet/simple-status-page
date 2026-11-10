import type { Config } from "./config";

export type Redactor = (text: string) => string;

export function logRedactor(config?: Config): Redactor {
	const secrets = config
		? [
				...config.monitors.flatMap((monitor) => [monitor.uuid, ...monitor.tokens]),
				config.salt,
				config.smtp?.password
			].filter((value): value is string => Boolean(value))
		: [];
	const variants = [
		...new Set(secrets.flatMap((secret) => [secret, encodeURIComponent(secret)]))
	].sort((left, right) => right.length - left.length);
	return (text) => {
		let safe = text;
		for (const secret of variants) safe = safe.split(secret).join("[REDACTED]");
		return safe
			.replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
			.replace(/(\/api\/monitor\/)[^\s/?#"'<>]+/gi, "$1[REDACTED]")
			.replace(/([?&](?:token|hash|email|password|secret|salt)=)[^\s&#"'<>]+/gi, "$1[REDACTED]");
	};
}

export function errorDetails(
	error: unknown,
	redact = logRedactor()
): {
	message: string;
	stack?: string;
	code?: string;
	status?: number;
} {
	const object =
		typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
	const response =
		typeof object.response === "object" && object.response !== null
			? (object.response as Record<string, unknown>)
			: {};
	const message =
		typeof object.message === "string"
			? object.message
			: typeof error === "string"
				? error
				: String(error);
	return {
		message: redact(message),
		stack: typeof object.stack === "string" ? redact(object.stack) : undefined,
		code: typeof object.code === "string" ? redact(object.code) : undefined,
		status: typeof response.status === "number" ? response.status : undefined
	};
}

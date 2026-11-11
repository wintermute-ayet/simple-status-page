import fs from "node:fs";
import yaml from "js-yaml";

export type MonitorStatus = "up" | "degraded" | "down" | "unknown";
export type IncidentType = "down" | "degraded";
export type ThemePreference = "light" | "dark" | "system";
export interface IncidentRule {
	createAfter: number;
	resolveAfter: number;
	message?: string;
}
export interface MonitorEntity {
	id: number;
	name: string;
	description: string;
	uuid: string;
	tokens: string[];
	visible: boolean;
	type: "http" | "api";
	url: string;
	checkInterval: number;
	retries: number;
	timeoutDownMs: number;
	timeoutDegradedMs: number;
	uptimeWording: string;
	group: string;
	regexp: string;
	compiledRegexp?: RegExp;
	incidents: Partial<Record<IncidentType, IncidentRule>>;
	validStatusCodes: number[];
	onMissing: "down" | "unknown";
}
export interface DailyThresholds {
	down: number;
	degraded: number;
}
export interface SmtpConfig {
	host: string;
	from: string;
	port: number;
	username: string;
	password: string;
}
export interface Config {
	public: {
		favicon: string;
		logo: string;
		logoDark: string;
		defaultTheme: ThemePreference;
		companyName: string;
		refreshInterval: number;
		basedomain: string;
	};
	salt: string;
	smtp?: SmtpConfig;
	groups: { name: string; monitors: number[] }[];
	database: { path: string };
	monitors: MonitorEntity[];
	dailyThresholds: DailyThresholds;
	cors: string[];
	proxy: boolean;
}

function object(value: unknown, location: string, keys: string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${location} must be an object`);
	}
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result)) {
		if (!keys.includes(key)) throw new Error(`Unknown configuration key: ${location}.${key}`);
	}
	return result;
}
function text(value: unknown, location: string, fallback?: string): string {
	if ((value === undefined || value === null) && fallback !== undefined) return fallback;
	if (typeof value !== "string" || (value.trim() === "" && fallback === undefined)) {
		throw new Error(`${location} must be a non-empty string`);
	}
	return value;
}
function number(value: unknown, location: string, fallback: number, minimum = 0): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new Error(`${location} must be a finite number >= ${minimum}`);
	}
	return value;
}
function integer(value: unknown, location: string, fallback: number, minimum = 1): number {
	const result = number(value, location, fallback, minimum);
	if (!Number.isSafeInteger(result)) throw new Error(`${location} must be a safe integer`);
	return result;
}
function boolean(value: unknown, location: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`${location} must be a boolean`);
	return value;
}
function array(value: unknown, location: string, fallback: unknown[] = []): unknown[] {
	if (value === undefined) return fallback;
	if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
	return value as unknown[];
}
function httpUrl(value: unknown, location: string): string {
	const result = text(value, location);
	try {
		const parsed = new URL(result);
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
			throw new Error();
		}
	} catch {
		throw new Error(`${location} must be an HTTP(S) URL without credentials`);
	}
	return result;
}

export function validateConfig(
	input: unknown,
	warn: (message: string) => void = console.warn
): Config {
	const root = object(input, "config", [
		"public",
		"salt",
		"smtp",
		"groups",
		"database",
		"monitors",
		"dailyThresholds",
		"cors",
		"proxy"
	]);
	const publicConfig = object(root.public ?? {}, "public", [
		"favicon",
		"logo",
		"logoDark",
		"defaultTheme",
		"companyName",
		"refreshInterval",
		"basedomain"
	]);
	const defaultTheme =
		publicConfig.defaultTheme === undefined ? "light" : publicConfig.defaultTheme;
	if (defaultTheme !== "light" && defaultTheme !== "dark" && defaultTheme !== "system")
		throw new Error("public.defaultTheme must be light, dark or system");
	const database = object(root.database, "database", ["path"]);
	const ids = new Set<number>();
	const tokens = new Set<string>();
	const monitors = array(root.monitors, "monitors").map((entry, index): MonitorEntity => {
		const location = `monitors[${index}]`;
		const raw = object(entry, location, [
			"id",
			"name",
			"description",
			"uuid",
			"tokens",
			"visible",
			"type",
			"url",
			"checkInterval",
			"retries",
			"timeoutDownMs",
			"timeoutDegradedMs",
			"timeoutDegradationMs",
			"uptimeWording",
			"group",
			"regexp",
			"incidents",
			"validStatusCodes",
			"onMissing"
		]);
		const id = integer(raw.id, `${location}.id`, 0);
		if (id === 0 || ids.has(id)) throw new Error(`${location}.id must be present and unique`);
		ids.add(id);
		if (raw.type !== "api" && raw.type !== "http")
			throw new Error(`${location}.type must be http or api`);
		const uuid = text(raw.uuid, `${location}.uuid`, raw.type === "http" ? "" : undefined);
		const extraTokens = array(raw.tokens, `${location}.tokens`).map((token, slot) =>
			text(token, `${location}.tokens[${slot}]`)
		);
		if (raw.type === "api") {
			for (const token of [uuid, ...extraTokens]) {
				if (token.length < 16)
					throw new Error(`${location} tokens must contain at least 16 characters`);
				if (tokens.has(token)) throw new Error(`${location} tokens must be unique`);
				tokens.add(token);
			}
		}
		if (raw.timeoutDegradationMs !== undefined) {
			warn(`${location}.timeoutDegradationMs is deprecated; use timeoutDegradedMs`);
			integer(raw.timeoutDegradationMs, `${location}.timeoutDegradationMs`, 1000);
		}
		const timeoutDownMs = integer(raw.timeoutDownMs, `${location}.timeoutDownMs`, 5000);
		const timeoutDegradedMs = integer(
			raw.timeoutDegradedMs ?? raw.timeoutDegradationMs,
			`${location}.timeoutDegradedMs`,
			1000
		);
		if (timeoutDegradedMs > timeoutDownMs)
			throw new Error(`${location}.timeoutDegradedMs must not exceed timeoutDownMs`);
		const regexp = text(raw.regexp, `${location}.regexp`, "");
		let compiledRegexp: RegExp | undefined;
		if (regexp) {
			try {
				compiledRegexp = new RegExp(regexp);
			} catch {
				throw new Error(`${location}.regexp is not a valid regular expression`);
			}
		}
		const rules = object(raw.incidents ?? {}, `${location}.incidents`, ["down", "degraded"]);
		const incidents: MonitorEntity["incidents"] = {};
		for (const type of ["down", "degraded"] as const) {
			if (rules[type] === undefined) continue;
			const rule = object(rules[type], `${location}.incidents.${type}`, [
				"createAfter",
				"resolveAfter",
				"message"
			]);
			incidents[type] = {
				createAfter: integer(rule.createAfter, `${location}.incidents.${type}.createAfter`, 1, 0),
				resolveAfter: integer(
					rule.resolveAfter,
					`${location}.incidents.${type}.resolveAfter`,
					1,
					0
				),
				message:
					rule.message === undefined
						? undefined
						: text(rule.message, `${location}.incidents.${type}.message`)
			};
		}
		const validStatusCodes = array(raw.validStatusCodes, `${location}.validStatusCodes`, [200]).map(
			(code) => {
				const result = integer(code, `${location}.validStatusCodes`, 200, 100);
				if (result > 599)
					throw new Error(`${location}.validStatusCodes must contain HTTP status codes`);
				return result;
			}
		);
		if (validStatusCodes.length === 0)
			throw new Error(`${location}.validStatusCodes must not be empty`);
		const onMissing = raw.onMissing ?? "down";
		if (onMissing !== "down" && onMissing !== "unknown")
			throw new Error(`${location}.onMissing must be down or unknown`);
		return {
			id,
			type: raw.type,
			name: text(raw.name, `${location}.name`),
			description: text(raw.description, `${location}.description`, ""),
			uuid,
			tokens: extraTokens,
			visible: boolean(raw.visible, `${location}.visible`, true),
			url: raw.type === "http" ? httpUrl(raw.url, `${location}.url`) : "",
			checkInterval: integer(raw.checkInterval, `${location}.checkInterval`, 60000, 1000),
			retries: integer(raw.retries, `${location}.retries`, 3),
			timeoutDownMs,
			timeoutDegradedMs,
			uptimeWording: text(raw.uptimeWording, `${location}.uptimeWording`, "uptime"),
			group: text(raw.group, `${location}.group`, ""),
			regexp,
			compiledRegexp,
			incidents,
			validStatusCodes,
			onMissing
		};
	});
	const groups = array(root.groups, "groups").map((entry, index) => {
		const location = `groups[${index}]`;
		const raw = object(entry, location, ["name", "monitors"]);
		const members = array(raw.monitors, `${location}.monitors`).map((id) => {
			const monitorId = integer(id, `${location}.monitors`, 0);
			if (!ids.has(monitorId)) throw new Error(`${location}.monitors references a missing monitor`);
			return monitorId;
		});
		return { name: text(raw.name, `${location}.name`), monitors: members };
	});
	let smtp: SmtpConfig | undefined;
	if (root.smtp !== undefined && root.smtp !== null) {
		const raw = object(root.smtp, "smtp", ["host", "from", "port", "username", "password"]);
		const port = integer(raw.port, "smtp.port", 587);
		if (port > 65535) throw new Error("smtp.port must not exceed 65535");
		smtp = {
			host: text(raw.host, "smtp.host"),
			from: text(raw.from, "smtp.from"),
			port,
			username: text(raw.username, "smtp.username", ""),
			password: text(raw.password, "smtp.password", "")
		};
		if (Boolean(smtp.username) !== Boolean(smtp.password))
			throw new Error("smtp username and password must be supplied together");
	}
	const thresholds = object(root.dailyThresholds ?? {}, "dailyThresholds", ["down", "degraded"]);
	const dailyThresholds = {
		down: number(thresholds.down, "dailyThresholds.down", 0.001),
		degraded: number(thresholds.degraded, "dailyThresholds.degraded", 0.005)
	};
	if (Object.values(dailyThresholds).some((threshold) => threshold > 1))
		throw new Error("dailyThresholds must be fractions between 0 and 1");
	const cors = array(root.cors, "cors").map((origin, index) => {
		const parsed = new URL(httpUrl(origin, `cors[${index}]`));
		if (parsed.pathname !== "/" || parsed.search || parsed.hash)
			throw new Error("cors must contain origins without paths or queries");
		return parsed.origin;
	});
	const salt = text(root.salt, "salt", smtp ? undefined : "");
	if (smtp && salt.length < 32)
		throw new Error("salt must contain at least 32 characters when SMTP is configured");
	return {
		public: {
			favicon: text(publicConfig.favicon, "public.favicon", ""),
			logo: text(publicConfig.logo, "public.logo", ""),
			logoDark: text(publicConfig.logoDark, "public.logoDark", ""),
			defaultTheme,
			companyName: text(publicConfig.companyName, "public.companyName", "Status"),
			refreshInterval: integer(publicConfig.refreshInterval, "public.refreshInterval", 900, 0),
			basedomain: httpUrl(
				publicConfig.basedomain ?? "http://localhost:3000",
				"public.basedomain"
			).replace(/\/$/, "")
		},
		salt,
		smtp,
		groups,
		database: { path: text(database.path, "database.path") },
		monitors,
		dailyThresholds,
		cors,
		proxy: boolean(root.proxy, "proxy", false)
	};
}

export function resolveConfigPath(override = process.env.CONFIG_PATH): string {
	if (override) return override;
	return fs.existsSync("data/config.yaml") ? "data/config.yaml" : "data/config.yml";
}
export function readConfig(configPath = resolveConfigPath()): Config {
	let parsed: unknown;
	try {
		parsed = yaml.load(fs.readFileSync(configPath, "utf8"));
	} catch {
		throw new Error("Unable to read or parse configuration YAML");
	}
	return validateConfig(parsed);
}

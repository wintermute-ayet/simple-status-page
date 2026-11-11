import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const required = [
	"background",
	"surface",
	"muted-surface",
	"text",
	"muted",
	"control-text",
	"border",
	"up",
	"degraded",
	"down",
	"unknown",
	"bar-up",
	"bar-degraded",
	"bar-down",
	"bar-unknown",
	"badge-up",
	"badge-degraded",
	"badge-down",
	"badge-unknown",
	"alert-degraded-bg",
	"alert-down-bg",
	"focus"
];

function luminance(hex: string): number {
	const channels = hex
		.slice(1)
		.match(/../g)!
		.map((value) => {
			const channel = parseInt(value, 16) / 255;
			return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string): number {
	const a = luminance(first);
	const b = luminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it.each([
	["light", /:root\s*\{([^}]*)\}/],
	["dark", /:root\[data-theme="dark"\]\s*\{([^}]*)\}/]
] as const)(
	"keeps %s text, badges and history bars readable against the card",
	(_theme, selector) => {
		const block = css.match(selector)?.[1];
		expect(block).toBeDefined();
		const variables = Object.fromEntries(
			[...block!.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [
				match[1],
				match[2]
			])
		);
		for (const name of required) expect(variables, `Missing --${name}`).toHaveProperty(name);
		for (const name of ["text", "muted"])
			expect(contrast(variables[name], variables.surface), `--${name}`).toBeGreaterThanOrEqual(4.5);
		expect(
			contrast(variables["control-text"], variables["muted-surface"]),
			"--control-text on muted surface"
		).toBeGreaterThanOrEqual(4.5);
		expect(
			contrast(variables.focus, variables["muted-surface"]),
			"--focus on muted surface"
		).toBeGreaterThanOrEqual(3);
		for (const status of ["up", "degraded", "down", "unknown"]) {
			expect(
				contrast(variables[`badge-${status}`], variables.surface),
				`--badge-${status}`
			).toBeGreaterThanOrEqual(4.5);
		}
		const unknownContrast = contrast(variables["bar-unknown"], variables.surface);
		expect(unknownContrast, "--bar-unknown remains visible").toBeGreaterThanOrEqual(1.4);
		expect(unknownContrast, "--bar-unknown stays subdued").toBeLessThanOrEqual(2.5);
		for (const status of ["up", "degraded", "down"]) {
			const barContrast = contrast(variables[`bar-${status}`], variables.surface);
			expect(barContrast, `--bar-${status}`).toBeGreaterThanOrEqual(3);
			expect(unknownContrast, `--bar-unknown is weaker than --bar-${status}`).toBeLessThan(
				barContrast
			);
		}
	}
);

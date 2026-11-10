import { describe, expect, it } from "vitest";
import { errorDetails, logRedactor } from "../src/logging";
import { makeConfig, testToken } from "./helpers";

describe("diagnostic redaction", () => {
	it("keeps useful messages and stacks while hiding credentials and push paths", () => {
		const rotation = "test-only-rotation-credential";
		const config = makeConfig({ tokens: [rotation] });
		const redact = logRedactor(config);
		const error = Object.assign(
			new Error(
				`Failed ${testToken} ${rotation} ${config.salt}; GET /api/monitor/unconfigured-token?token=another-secret; Bearer final-secret`
			),
			{ code: "ECONNRESET", response: { status: 503 } }
		);
		const details = errorDetails(error, redact);
		expect(details).toMatchObject({ code: "ECONNRESET", status: 503 });
		expect(details.message).toContain("Failed");
		expect(details.stack).toContain("Error:");
		for (const value of [
			testToken,
			rotation,
			config.salt,
			"unconfigured-token",
			"another-secret",
			"final-secret"
		])
			expect(JSON.stringify(details)).not.toContain(value);
	});
	it("keeps string rejection reasons and handles non-Error values", () => {
		expect(errorDetails("SMTP unavailable").message).toBe("SMTP unavailable");
		expect(errorDetails(null).message).toBe("null");
		expect(errorDetails(undefined).message).toBe("undefined");
	});
});

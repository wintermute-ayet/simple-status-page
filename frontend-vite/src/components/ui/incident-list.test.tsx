import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import IncidentList from "./incident-list";

it("escapes incident text and preserves newlines and legacy breaks", () => {
	const html = renderToStaticMarkup(
		React.createElement(IncidentList, {
			data: [
				{
					id: 1,
					monitor_id: 1,
					monitor_name: "Example service",
					type: "down",
					status: "active",
					created: "2030-01-01 00:00:00",
					modified: "2030-01-01 00:00:00",
					message: '<script>alert("unsafe")</script><br /><img src=x onerror=alert(1)>\nSecond line'
				}
			]
		})
	);
	expect(html).toContain("whitespace-pre-line");
	expect(html).toContain("&lt;script&gt;");
	expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	expect(html).toContain("&lt;/script&gt;\n&lt;img");
	expect(html).toContain("\nSecond line");
	expect(html).not.toContain("<script");
	expect(html).not.toContain("<img");
});

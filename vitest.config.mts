import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	resolve: { alias: { "@": fileURLToPath(new URL("./frontend-vite/src", import.meta.url)) } },
	test: {
		environment: "node",
		include: [
			"tests/**/*.test.ts",
			"frontend-vite/src/**/*.test.ts",
			"frontend-vite/src/**/*.test.tsx"
		],
		clearMocks: true,
		restoreMocks: true
	}
});

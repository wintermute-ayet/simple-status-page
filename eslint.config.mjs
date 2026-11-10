import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
	{ ignores: ["dist/**", "frontend-vite/**"] },
	{
		files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.mts"],
		extends: [js.configs.recommended, tseslint.configs.recommended],
		languageOptions: { globals: globals.node }
	},
	{
		files: ["src/**/*.ts"],
		rules: {
			// Existing database rows and HTTP error bodies are not fully typed yet.
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
			"@typescript-eslint/no-require-imports": ["error", { allow: ["^crypto$"] }]
		}
	}
);

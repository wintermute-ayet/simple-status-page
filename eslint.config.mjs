import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
	{ ignores: ["dist/**", "frontend-vite/**"] },
	{
		files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.mts"],
		extends: [js.configs.recommended, tseslint.configs.recommended],
		languageOptions: {
			globals: globals.node,
			parserOptions: {
				project: ["./tsconfig.json", "./tsconfig.test.json"],
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error"
		}
	}
);

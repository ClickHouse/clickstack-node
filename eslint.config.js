import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import tsdoc from "eslint-plugin-tsdoc";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["coverage/", "dist/", "pack/"]),
  {
    files: ["**/*.ts", "*.config.js"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      comments.recommended,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // The tsconfig cannot include .js files: allowJs conflicts with isolatedDeclarations.
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { tsdoc },
    rules: {
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unused-disable": "error",
      "tsdoc/syntax": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-console": "error",
      // tsdown rewrites import.meta for the CJS build; these globals do not exist in the ESM build.
      "no-restricted-globals": ["error", "__filename", "__dirname", "require"],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            "node:http",
            "node:https",
            "node:net",
            "node:dns",
            "node:fs",
          ].map((name) => ({
            name,
            allowTypeImports: true,
            message:
              "A value import creates the ES module facade before instrumentation starts, so the app's named imports stay unpatched. Use process.getBuiltinModule() lazily.",
          })),
        },
      ],
    },
  },
  {
    // The ESM build declares `require` in these files only (tsdown.config.ts).
    files: ["src/hook.ts", "src/sdk.ts"],
    rules: {
      "no-restricted-globals": ["error", "__filename", "__dirname"],
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["e2e/fixtures/**/*.{cjs,mjs,js}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
]);

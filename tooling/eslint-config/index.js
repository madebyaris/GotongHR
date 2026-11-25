import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const boundaryMessage =
  "Import another module only through a port in @gotonghr/contracts.";

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  module: "readonly",
  require: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  Buffer: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.data/**",
      "**/coverage/**",
      "**/.turbo/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@gotonghr/db",
              message: "apps/web does not import the database package.",
            },
          ],
          patterns: [
            {
              group: [
                "@gotonghr/db/*",
                "**/packages/db/**",
                "**/packages/modules/**",
              ],
              message: "apps/web does not import packages/db or packages/modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/modules/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/packages/modules/**"],
              message: boundaryMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/payroll-engine/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "drizzle-orm",
              message: "packages/payroll-engine does no database work.",
            },
            {
              name: "pg",
              message: "packages/payroll-engine does no database work.",
            },
            {
              name: "postgres",
              message: "packages/payroll-engine does no database work.",
            },
            {
              name: "fastify",
              message: "packages/payroll-engine does no network work.",
            },
          ],
          patterns: [
            {
              group: ["drizzle-orm/*", "@aws-sdk/*", "**/packages/modules/**"],
              message:
                "packages/payroll-engine does no database, network, or module work.",
            },
          ],
        },
      ],
    },
  },
);

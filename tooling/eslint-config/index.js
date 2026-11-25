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
            {
              name: "@gotonghr/db",
              message: "packages/payroll-engine does no database work.",
            },
            {
              name: "@gotonghr/storage",
              message: "packages/payroll-engine does no storage work.",
            },
          ],
          patterns: [
            {
              group: [
                "drizzle-orm/*",
                "pg/*",
                "postgres/*",
                "fastify/*",
                "@fastify/*",
                "@aws-sdk/*",
                "@gotonghr/db",
                "@gotonghr/db/*",
                "@gotonghr/storage",
                "@gotonghr/storage/*",
                "**/packages/modules/**",
                "**/packages/db/**",
                "**/packages/storage/**",
              ],
              message:
                "packages/payroll-engine does no database, network, storage, or module work.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/payslip-pdf/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "drizzle-orm",
              message: "packages/payslip-pdf does no database work.",
            },
            {
              name: "pg",
              message: "packages/payslip-pdf does no database work.",
            },
            {
              name: "postgres",
              message: "packages/payslip-pdf does no database work.",
            },
            {
              name: "fastify",
              message: "packages/payslip-pdf does no network work.",
            },
            {
              name: "puppeteer",
              message: "packages/payslip-pdf does not use Chromium.",
            },
            {
              name: "playwright",
              message: "packages/payslip-pdf does not use Chromium.",
            },
            {
              name: "@gotonghr/db",
              message: "packages/payslip-pdf does no database work.",
            },
            {
              name: "@gotonghr/storage",
              message: "packages/payslip-pdf does no storage work.",
            },
          ],
          patterns: [
            {
              group: [
                "drizzle-orm/*",
                "pg/*",
                "postgres/*",
                "fastify/*",
                "@fastify/*",
                "@aws-sdk/*",
                "puppeteer",
                "puppeteer-core",
                "playwright",
                "playwright-core",
                "@sparticuz/chromium",
                "node:http",
                "node:https",
                "undici",
                "@gotonghr/db",
                "@gotonghr/db/*",
                "@gotonghr/storage",
                "@gotonghr/storage/*",
                "**/packages/modules/**",
                "**/packages/db/**",
                "**/packages/storage/**",
              ],
              message:
                "packages/payslip-pdf does no database, network, storage, Chromium, or module work.",
            },
          ],
        },
      ],
    },
  },
);

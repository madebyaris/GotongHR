import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const boundaryMessage =
  "Import another module only through a port in @gotonghr/contracts.";

const sharedPureGroups = [
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
];

function purePackagePaths(packageName) {
  const database = `${packageName} does no database work.`;
  const network = `${packageName} does no network work.`;
  const storage = `${packageName} does no storage work.`;
  return [
    { name: "drizzle-orm", message: database },
    { name: "pg", message: database },
    { name: "postgres", message: database },
    { name: "fastify", message: network },
    { name: "@gotonghr/db", message: database },
    { name: "@gotonghr/storage", message: storage },
  ];
}

function purePackageImportRule(packageName, extra) {
  return [
    "error",
    {
      paths: [...purePackagePaths(packageName), ...(extra.paths ?? [])],
      patterns: [
        {
          group: [...sharedPureGroups, ...(extra.groups ?? [])],
          message: extra.message,
        },
      ],
    },
  ];
}

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
            {
              name: "@gotonghr/crypto",
              message: "apps/web cannot import @gotonghr/crypto.",
            },
          ],
          patterns: [
            {
              group: [
                "@gotonghr/db/*",
                "@gotonghr/crypto",
                "@gotonghr/crypto/*",
                "**/packages/db/**",
                "**/packages/crypto/**",
                "**/packages/modules/**",
              ],
              message: "apps/web does not import packages/db, packages/crypto, or packages/modules.",
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
              group: [
                "**/packages/modules/**",
                "@gotonghr/identity",
                "@gotonghr/identity/*",
                "@gotonghr/platform",
                "@gotonghr/platform/*",
              ],
              message: boundaryMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/modules/platform/src/isolation.integration.test.ts",
      "packages/modules/platform/src/isolation-schema.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["packages/payroll-engine/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": purePackageImportRule("packages/payroll-engine", {
        message:
          "packages/payroll-engine does no database, network, storage, or module work.",
        paths: [
          {
            name: "@gotonghr/crypto",
            message: "packages/payroll-engine does no PII crypto.",
          },
        ],
        groups: ["@gotonghr/crypto", "@gotonghr/crypto/*", "**/packages/crypto/**"],
      }),
    },
  },
  {
    files: ["packages/payslip-pdf/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": purePackageImportRule("packages/payslip-pdf", {
        message:
          "packages/payslip-pdf does no database, network, storage, Chromium, or module work.",
        paths: [
          {
            name: "puppeteer",
            message: "packages/payslip-pdf does not use Chromium.",
          },
          {
            name: "playwright",
            message: "packages/payslip-pdf does not use Chromium.",
          },
          {
            name: "http",
            message: "packages/payslip-pdf does no network work.",
          },
          {
            name: "https",
            message: "packages/payslip-pdf does no network work.",
          },
          {
            name: "node:http",
            message: "packages/payslip-pdf does no network work.",
          },
          {
            name: "node:https",
            message: "packages/payslip-pdf does no network work.",
          },
          {
            name: "@gotonghr/crypto",
            message: "packages/payslip-pdf cannot import @gotonghr/crypto.",
          },
        ],
        groups: [
          "puppeteer",
          "puppeteer-core",
          "playwright",
          "playwright-core",
          "@sparticuz/chromium",
          "http",
          "node:http",
          "https",
          "node:https",
          "undici",
          "@gotonghr/crypto",
          "@gotonghr/crypto/*",
          "**/packages/crypto/**",
        ],
      }),
    },
  },
);

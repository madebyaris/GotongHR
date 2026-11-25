/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-sibling-module-imports",
      severity: "error",
      comment:
        "packages/modules/* cannot import a sibling module schema or internals.",
      from: { path: "^packages/modules/([^/]+)/" },
      to: {
        path: "^packages/modules/",
        pathNot: "^packages/modules/$1/",
      },
    },
    {
      name: "payroll-engine-stays-pure",
      severity: "error",
      comment:
        "packages/payroll-engine cannot import drizzle-orm, pg, postgres, fastify, @aws-sdk/*, @gotonghr/db, @gotonghr/storage, or packages/modules.",
      from: { path: "^packages/payroll-engine/" },
      to: {
        path: "(^|/)node_modules/(drizzle-orm|pg|postgres|fastify|@aws-sdk|@gotonghr/db|@gotonghr/storage)(/|$)|^packages/(modules|db|storage)/",
      },
    },
    {
      name: "payslip-pdf-stays-pure",
      severity: "error",
      comment:
        "packages/payslip-pdf cannot import a database, HTTP, storage, Chromium, or another module.",
      from: { path: "^packages/payslip-pdf/" },
      to: {
        path: "(^|/)node_modules/(drizzle-orm|pg|postgres|fastify|@fastify|@aws-sdk|@gotonghr/db|@gotonghr/storage|puppeteer|puppeteer-core|playwright|playwright-core|@sparticuz/chromium|chrome-aws-lambda|undici|axios|node-fetch)(/|$)|^packages/(modules|db|storage)/|^(node:)?(http|https)$",
      },
    },
    {
      name: "web-does-not-import-server",
      severity: "error",
      comment: "apps/web cannot import packages/modules or packages/db.",
      from: { path: "^apps/web/" },
      to: { path: "^packages/(modules|db)(/|$)" },
    },
    {
      name: "no-crypto-in-payroll-payslip-or-web",
      severity: "error",
      comment:
        "packages/payroll-engine, packages/payslip-pdf, and apps/web cannot import @gotonghr/crypto.",
      from: { path: "^(packages/payroll-engine|packages/payslip-pdf|apps/web)/" },
      to: {
        path: "(^|/)node_modules/@gotonghr/crypto(/|$)|^packages/crypto(/|$)",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
    },
  },
};

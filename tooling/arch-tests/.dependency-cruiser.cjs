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
      name: "web-does-not-import-server",
      severity: "error",
      comment: "apps/web cannot import packages/modules or packages/db.",
      from: { path: "^apps/web/" },
      to: { path: "^packages/(modules|db)(/|$)" },
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

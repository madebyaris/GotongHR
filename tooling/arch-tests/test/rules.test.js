import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const config = require("../.dependency-cruiser.cjs");

test("architecture rules cover module boundaries", () => {
  const names = config.forbidden.map((rule) => rule.name);
  assert.deepEqual(names, [
    "no-sibling-module-imports",
    "payroll-engine-stays-pure",
    "payslip-pdf-stays-pure",
    "web-does-not-import-server",
  ]);
  const payslip = config.forbidden.find((rule) => rule.name === "payslip-pdf-stays-pure");
  assert.match(payslip.from.path, /payslip-pdf/);
  assert.match(payslip.to.path, /puppeteer/);
  assert.match(payslip.to.path, /playwright/);
  assert.match(payslip.to.path, /drizzle-orm/);
  assert.match(payslip.to.path, /(^|[|(])fastify([|)/])/);
  assert.match(payslip.to.path, /(^|[|(])@fastify([|)/])/);
  assert.match(payslip.to.path, /@gotonghr\/storage/);
  for (const rule of config.forbidden) {
    assert.equal(rule.severity, "error");
  }
});

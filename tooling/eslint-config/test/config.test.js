import assert from "node:assert/strict";
import test from "node:test";
import config from "../index.js";

test("the shared config is a non-empty flat config", () => {
  assert.ok(Array.isArray(config));
  assert.ok(config.length > 3);
});

function entry(fragment) {
  const found = config.find((item) => {
    const files = item.files;
    const list = Array.isArray(files) ? files : [files];
    return list.some((file) => typeof file === "string" && file.includes(fragment));
  });
  assert.ok(found, fragment);
  return found;
}

function restriction(fragment) {
  const rule = entry(fragment).rules["no-restricted-imports"];
  assert.equal(rule[0], "error");
  const options = rule[1];
  assert.equal(typeof options, "object");
  assert.ok(Array.isArray(options.paths));
  assert.ok(Array.isArray(options.patterns));
  return options;
}

test("web, modules, and payroll-engine keep their import boundaries", () => {
  const web = JSON.stringify(entry("apps/web").rules["no-restricted-imports"]);
  assert.match(web, /apps\/web does not import the database package/);

  const modules = JSON.stringify(entry("packages/modules").rules["no-restricted-imports"]);
  assert.match(modules, /packages\/modules/);

  const payroll = restriction("packages/payroll-engine");
  assert.deepEqual(
    payroll.paths.map((item) => item.name),
    ["drizzle-orm", "pg", "postgres", "fastify", "@gotonghr/db", "@gotonghr/storage"],
  );
  assert.ok(payroll.paths.every((item) => item.message.includes("packages/payroll-engine does no")));
  assert.deepEqual(payroll.patterns[0].group, [
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
  ]);
  assert.match(payroll.patterns[0].message, /packages\/payroll-engine does no database, network, storage, or module work/);

  const payslip = restriction("packages/payslip-pdf");
  assert.deepEqual(
    payslip.paths.map((item) => item.name),
    [
      "drizzle-orm",
      "pg",
      "postgres",
      "fastify",
      "@gotonghr/db",
      "@gotonghr/storage",
      "puppeteer",
      "playwright",
      "http",
      "https",
      "node:http",
      "node:https",
    ],
  );
  assert.equal(
    payslip.paths.find((item) => item.name === "playwright").message,
    "packages/payslip-pdf does not use Chromium.",
  );
  assert.equal(
    payslip.paths.find((item) => item.name === "@gotonghr/db").message,
    "packages/payslip-pdf does no database work.",
  );
  assert.equal(
    payslip.paths.find((item) => item.name === "http").message,
    "packages/payslip-pdf does no network work.",
  );
  assert.deepEqual(payslip.patterns[0].group, [
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
  ]);
  assert.match(
    payslip.patterns[0].message,
    /packages\/payslip-pdf does no database, network, storage, Chromium, or module work/,
  );
});

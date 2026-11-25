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

test("web, modules, and payroll-engine keep their import boundaries", () => {
  const web = JSON.stringify(entry("apps/web").rules["no-restricted-imports"]);
  assert.match(web, /apps\/web does not import the database package/);

  const modules = JSON.stringify(entry("packages/modules").rules["no-restricted-imports"]);
  assert.match(modules, /packages\/modules/);

  const payroll = JSON.stringify(entry("packages/payroll-engine").rules["no-restricted-imports"]);
  assert.match(payroll, /packages\/payroll-engine does no database work/);
  assert.match(payroll, /@gotonghr\/db/);
  assert.match(payroll, /@gotonghr\/storage/);
  assert.match(payroll, /pg\/\*/);
  assert.match(payroll, /@fastify\/\*/);
});

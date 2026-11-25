import assert from "node:assert/strict";
import test from "node:test";
import { consumesPayrollPorts, ownedPayrollPorts, readConfig } from "./config.ts";

const base = {
  GOTONG_DEPLOYMENT_MODE: "single_tenant",
  STORAGE_DRIVER: "local",
  PORT: "3000",
  HOST: "127.0.0.1",
};

test("config defaults to the monolith, pg-boss, and in-process ports", () => {
  const config = readConfig({ ...base });
  assert.equal(config.role, "monolith");
  assert.equal(config.queueDriver, "pgboss");
  assert.equal(config.portTransport, "inproc");
  assert.equal(config.internalSecret, null);
  assert.equal(config.portUrls, null);
});

test("config accepts the sqs driver and still defaults the transport to inproc", () => {
  const config = readConfig({ ...base, QUEUE_DRIVER: "sqs" });
  assert.equal(config.queueDriver, "sqs");
  assert.equal(config.portTransport, "inproc");
});

test("http transport requires a secret, and a caller requires port urls", () => {
  assert.throws(
    () => readConfig({ ...base, GOTONG_ROLE: "worker", PORT_TRANSPORT: "http" }),
    /INTERNAL_SERVICE_SECRET/,
  );
  const secret = "internal-secret-0123456789";
  assert.throws(
    () =>
      readConfig({
        ...base,
        GOTONG_ROLE: "worker",
        PORT_TRANSPORT: "http",
        INTERNAL_SERVICE_SECRET: secret,
      }),
    /CORE_HR_PORT_URL/,
  );
  const config = readConfig({
    ...base,
    GOTONG_ROLE: "attendance",
    PORT_TRANSPORT: "http",
    INTERNAL_SERVICE_SECRET: secret,
  });
  assert.equal(config.internalSecret, secret);
  assert.equal(config.portUrls, null);
  assert.deepEqual(ownedPayrollPorts("attendance"), ["core-hr", "attendance"]);
  assert.deepEqual(ownedPayrollPorts("ai"), ["statutory"]);
  assert.deepEqual(ownedPayrollPorts("worker"), []);
  assert.equal(consumesPayrollPorts("worker"), true);
  assert.equal(consumesPayrollPorts("attendance"), false);
});

test("config rejects an unknown role, driver, or transport", () => {
  assert.throws(() => readConfig({ ...base, GOTONG_ROLE: "api" }), /GOTONG_ROLE/);
  assert.throws(() => readConfig({ ...base, QUEUE_DRIVER: "redis" }), /QUEUE_DRIVER/);
  assert.throws(() => readConfig({ ...base, PORT_TRANSPORT: "grpc" }), /PORT_TRANSPORT/);
});

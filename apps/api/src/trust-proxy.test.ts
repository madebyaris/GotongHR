import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrustProxy, trustProxyHops } from "./trust-proxy.ts";

const trustOne = trustProxyHops(1);

test("one hop trusts a private peer and ignores a direct client", () => {
  assert.equal(trustOne("127.0.0.1", 0), true);
  assert.equal(trustOne("::1", 0), true);
  assert.equal(trustOne("10.1.2.3", 0), true);
  assert.equal(trustOne("172.18.0.2", 0), true);
  assert.equal(trustOne("192.168.1.1", 0), true);
  assert.equal(trustOne("203.0.113.9", 0), false);
  assert.equal(trustOne("10.1.2.3", 1), false);
  assert.equal(trustOne("::ffff:127.0.0.1", 0), true);
  assert.equal(trustOne("::ffff:10.1.2.3", 0), true);
  assert.equal(trustOne("::ffff:203.0.113.9", 0), false);
  assert.equal(trustOne("fd00::1", 0), true);
  assert.equal(trustOne("fe80::1", 0), true);
  assert.equal(trustOne("2001:db8::1", 0), false);
  assert.equal(trustOne(undefined, 0), false);
});

test("an explicit CIDR list trusts only those proxies", () => {
  const trust = resolveTrustProxy(["203.0.113.0/24", "fd00::/8"]);
  assert.equal(typeof trust, "function");
  if (typeof trust !== "function") return;
  assert.equal(trust("203.0.113.9", 0), true);
  assert.equal(trust("::ffff:203.0.113.9", 0), true);
  assert.equal(trust("198.51.100.1", 0), false);
  assert.equal(trust("fd00::1", 0), true);
  assert.equal(trust("2001:db8::1", 0), false);
  const allowMissing = trust as (address: string | undefined, hop: number) => boolean;
  assert.equal(allowMissing(undefined, 0), false);
});

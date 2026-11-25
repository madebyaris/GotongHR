import assert from "node:assert/strict";
import test from "node:test";
import { trustProxyHops } from "./trust-proxy.ts";

const trustOne = trustProxyHops(1);

test("one hop trusts a private peer and ignores a direct client", () => {
  assert.equal(trustOne("127.0.0.1", 0), true);
  assert.equal(trustOne("::1", 0), true);
  assert.equal(trustOne("10.1.2.3", 0), true);
  assert.equal(trustOne("172.18.0.2", 0), true);
  assert.equal(trustOne("192.168.1.1", 0), true);
  assert.equal(trustOne("203.0.113.9", 0), false);
  assert.equal(trustOne("10.1.2.3", 1), false);
});

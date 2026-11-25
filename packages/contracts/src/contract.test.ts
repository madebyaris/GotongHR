import assert from "node:assert/strict";
import test from "node:test";
import { fail, ok } from "./envelope.ts";
import { idr } from "./idr.ts";
import { isPermissionAtom, permissionAtoms } from "./permissions.ts";
import {
  isPrivilegedRole,
  permissionRequiresPrivilegedTotp,
  roleCodes,
  roleHasPermission,
  rolePermissions,
  roleScopeDefaults,
} from "./roles.ts";

test("the JSON envelope keeps data, meta, and error together", () => {
  assert.deepEqual(ok({ status: "ok" }), {
    data: { status: "ok" },
    meta: null,
    error: null,
  });
  assert.deepEqual(ok({ status: "ok" }, { page: 1 }), {
    data: { status: "ok" },
    meta: { page: 1 },
    error: null,
  });
  assert.deepEqual(fail("not_ready", "database"), {
    data: null,
    meta: null,
    error: { code: "not_ready", message: "database" },
  });
  assert.deepEqual(fail("not_ready", "database", { page: 1 }), {
    data: null,
    meta: { page: 1 },
    error: { code: "not_ready", message: "database" },
  });
});

test("idr accepts only bigint rupiah", () => {
  assert.equal(idr(1500000n), 1500000n);
  assert.throws(() => idr(1 as never), /bigint/);
});

test("permission atoms are the spec set", () => {
  assert.deepEqual(permissionAtoms, [
    "employee.pii.read",
    "employee.pii.reveal",
    "attendance.approve",
    "payroll.run.prepare",
    "payroll.run.create",
    "payroll.run.finalize",
    "payroll.coretax.export",
    "ai.action.approve",
    "audit.log.read",
  ]);
  assert.equal(new Set(permissionAtoms).size, permissionAtoms.length);
  assert.equal(isPermissionAtom("employee.pii.reveal"), true);
  assert.equal(isPermissionAtom("payroll.run.delete"), false);
});

test("built-in roles keep finalize and PII off the employee", () => {
  assert.deepEqual(roleCodes, [
    "org_owner",
    "hr_admin",
    "payroll_admin",
    "finance_viewer",
    "branch_manager",
    "line_manager",
    "employee",
    "it_security_admin",
  ]);
  assert.equal(roleHasPermission("employee", "employee.pii.read"), false);
  assert.equal(roleHasPermission("org_owner", "payroll.run.finalize"), true);
  assert.equal(roleHasPermission("hr_admin", "payroll.run.finalize"), false);
  assert.equal(roleHasPermission("payroll_admin", "payroll.run.finalize"), false);
  assert.deepEqual(rolePermissions.finance_viewer, ["audit.log.read"]);
  assert.equal(roleScopeDefaults.employee.selfOnly, true);
  assert.equal(roleScopeDefaults.line_manager.directReportsOnly, true);
  assert.equal(roleScopeDefaults.org_owner.selfOnly, false);
  assert.equal(isPrivilegedRole("org_owner"), true);
  assert.equal(isPrivilegedRole("employee"), false);
  assert.equal(isPrivilegedRole("branch_manager"), false);
  assert.equal(permissionRequiresPrivilegedTotp("employee.pii.read"), true);
  assert.equal(permissionRequiresPrivilegedTotp("payroll.run.finalize"), true);
  assert.equal(permissionRequiresPrivilegedTotp("attendance.approve"), false);
});

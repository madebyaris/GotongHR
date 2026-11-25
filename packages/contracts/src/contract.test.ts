import assert from "node:assert/strict";
import test from "node:test";
import { fail, failWithFields, ok } from "./envelope.ts";
import {
  canWriteOrg,
  idrToJson,
  parseBranchCreate,
  parseLegalEntityCreate,
  parseNitku22,
  parseNpwp16,
  parseUmpIdr,
} from "./org.ts";
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

test("field errors name the field and keep the envelope", () => {
  assert.deepEqual(
    failWithFields("invalid_field", "Check the highlighted fields.", [
      { field: "nitku22", message: "NITKU must be 22 digits." },
    ]),
    {
      data: null,
      meta: null,
      error: {
        code: "invalid_field",
        message: "Check the highlighted fields.",
        fields: [{ field: "nitku22", message: "NITKU must be 22 digits." }],
      },
    },
  );
});

test("NPWP is 16 digits and NITKU is 22 digits", () => {
  assert.equal(parseNpwp16("0123456789012345").ok, true);
  assert.equal(parseNpwp16("123456789012345").ok, false);
  assert.equal(parseNpwp16("12345678901234567").ok, false);
  assert.equal(parseNpwp16("01.234.567.8-901.234").ok, false);
  assert.equal(parseNitku22("0123456789012345678901").ok, true);
  assert.equal(parseNitku22("123456789012345678901").ok, false);
  assert.equal(parseNitku22("12345678901234567890123").ok, false);
  assert.equal(parseNitku22("012345678901234567890A").ok, false);
  const entity = parseLegalEntityCreate({
    companyName: " PT Surya ",
    npwp16: "0123456789012345",
  });
  assert.equal(entity.ok, true);
  if (entity.ok) assert.equal(entity.value.companyName, "PT Surya");
});

test("UMP is non-negative bigint rupiah, including values above the JSON safe integer", () => {
  const grouped = parseUmpIdr("5.396.761");
  assert.equal(grouped.ok, true);
  if (grouped.ok) assert.equal(grouped.value, 5396761n);
  const asNumber = parseUmpIdr(5396761);
  assert.equal(asNumber.ok, true);
  if (asNumber.ok) assert.equal(idrToJson(asNumber.value), "5396761");
  const huge = parseUmpIdr("9007199254740993");
  assert.equal(huge.ok, true);
  if (huge.ok) assert.equal(idrToJson(huge.value), "9007199254740993");
  assert.equal(parseUmpIdr(1.5).ok, false);
  assert.equal(parseUmpIdr(-1).ok, false);
  assert.equal(parseUmpIdr("9223372036854775808").ok, false);
  assert.equal(parseUmpIdr(Number.MAX_SAFE_INTEGER + 2).ok, false);
  const branch = parseBranchCreate({
    legalEntityId: "018f3a4c-7b2a-7c3d-8e4f-123456789abc",
    name: "Jakarta Pusat",
    nitku22: "123",
    timezone: "WIB",
    umpUmkIdr: "5.396.761",
  });
  assert.equal(branch.ok, false);
  if (!branch.ok) {
    assert.equal(branch.fields.some((field) => field.field === "nitku22"), true);
    assert.equal(branch.fields.some((field) => field.field === "timezone"), true);
  }
  assert.equal(canWriteOrg("org_owner"), true);
  assert.equal(canWriteOrg("hr_admin"), true);
  assert.equal(canWriteOrg("payroll_admin"), false);
  assert.equal(canWriteOrg("employee"), false);
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
  assert.equal(roleHasPermission("branch_manager", "employee.pii.read"), false);
  assert.equal(roleHasPermission("branch_manager", "attendance.approve"), true);
  assert.equal(roleHasPermission("org_owner", "payroll.run.finalize"), true);
  assert.equal(roleHasPermission("org_owner", "payroll.run.prepare"), false);
  assert.equal(roleHasPermission("org_owner", "payroll.run.create"), false);
  assert.equal(roleHasPermission("hr_admin", "payroll.run.prepare"), true);
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

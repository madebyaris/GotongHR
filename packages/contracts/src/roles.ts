import { type PermissionAtom } from "./permissions.ts";

/**
 * Built-in membership roles. Better Auth's organization roles are not these.
 * A later slice may insert more codes; permissions are the stored text array.
 */
export const roleCodes = [
  "org_owner",
  "hr_admin",
  "payroll_admin",
  "finance_viewer",
  "branch_manager",
  "line_manager",
  "employee",
  "it_security_admin",
] as const;

export type RoleCode = (typeof roleCodes)[number];

/** Spec set that must enroll TOTP before payroll or PII routes run. */
export const privilegedRoleCodes = [
  "org_owner",
  "hr_admin",
  "payroll_admin",
  "finance_viewer",
  "it_security_admin",
] as const;

export type PrivilegedRoleCode = (typeof privilegedRoleCodes)[number];

const roleCodeSet: ReadonlySet<string> = new Set(roleCodes);
const privilegedRoleSet: ReadonlySet<string> = new Set(privilegedRoleCodes);

export function isRoleCode(value: string): value is RoleCode {
  return roleCodeSet.has(value);
}

export function isPrivilegedRole(value: string): value is PrivilegedRoleCode {
  return privilegedRoleSet.has(value);
}

export interface RoleScopeDefault {
  directReportsOnly: boolean;
  selfOnly: boolean;
}

/**
 * Empty scope arrays are not a deny. They mean "not restricted to a list yet".
 * `self_only` and `direct_reports_only` are the restrictions that are on.
 */
export const roleScopeDefaults: Record<RoleCode, RoleScopeDefault> = {
  org_owner: { directReportsOnly: false, selfOnly: false },
  hr_admin: { directReportsOnly: false, selfOnly: false },
  payroll_admin: { directReportsOnly: false, selfOnly: false },
  finance_viewer: { directReportsOnly: false, selfOnly: false },
  branch_manager: { directReportsOnly: false, selfOnly: false },
  line_manager: { directReportsOnly: true, selfOnly: false },
  employee: { directReportsOnly: false, selfOnly: true },
  it_security_admin: { directReportsOnly: false, selfOnly: false },
};

/**
 * Seed copied into `id_roles` when a tenant is created. The request guard
 * checks that stored array. Changing this map does not update an existing
 * tenant, and `roleHasPermission` reads the seed, so it can disagree with a
 * row that was edited later. Identity migrate appends `employee.read` and
 * `employee.write` onto the built-in roles that have them here.
 *
 * `org_owner` may finalize a payroll run and may not prepare or create one.
 * `hr_admin` and `payroll_admin` prepare. The preparer is not the finalizer.
 * `branch_manager` does not receive `employee.read` until branch row
 * scoping exists (Slice 2.x). Employee routes filter rows by scope when
 * the arrays are non-empty. `self_only` and `direct_reports_only` stay off
 * the directory until an employee is linked to a user.
 */
export const rolePermissions = {
  org_owner: [
    "employee.read",
    "employee.write",
    "employee.pii.read",
    "employee.pii.reveal",
    "attendance.approve",
    "payroll.run.finalize",
    "payroll.coretax.export",
    "ai.action.approve",
    "audit.log.read",
    "tenant.support_grant.write",
  ],
  hr_admin: [
    "employee.read",
    "employee.write",
    "employee.pii.read",
    "employee.pii.reveal",
    "attendance.approve",
    "payroll.run.prepare",
    "payroll.run.create",
    "ai.action.approve",
  ],
  payroll_admin: [
    "employee.read",
    "employee.pii.read",
    "payroll.run.prepare",
    "payroll.run.create",
    "payroll.coretax.export",
  ],
  finance_viewer: ["audit.log.read"],
  branch_manager: ["attendance.approve"],
  line_manager: ["attendance.approve"],
  employee: [],
  it_security_admin: [
    "employee.read",
    "audit.log.read",
    "employee.pii.read",
    "tenant.support_grant.write",
  ],
} as const satisfies Record<RoleCode, readonly PermissionAtom[]>;

export function roleHasPermission(role: RoleCode, atom: PermissionAtom): boolean {
  return rolePermissions[role].some((permission) => permission === atom);
}

/** Payroll, PII, and support-grant writes need TOTP from a privileged role. */
export function permissionRequiresPrivilegedTotp(atom: PermissionAtom): boolean {
  return (
    atom === "tenant.support_grant.write" ||
    atom.startsWith("employee.pii.") ||
    atom.startsWith("payroll.")
  );
}

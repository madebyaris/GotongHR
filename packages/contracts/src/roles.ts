import { permissionAtoms, type PermissionAtom } from "./permissions.ts";

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
 * `payroll.run.finalize` stays with `org_owner` so the preparer is not the
 * finalizer. Employee ESS has no admin atoms.
 */
export const rolePermissions = {
  org_owner: permissionAtoms,
  hr_admin: [
    "employee.pii.read",
    "employee.pii.reveal",
    "attendance.approve",
    "payroll.run.prepare",
    "payroll.run.create",
    "ai.action.approve",
  ],
  payroll_admin: [
    "employee.pii.read",
    "payroll.run.prepare",
    "payroll.run.create",
    "payroll.coretax.export",
  ],
  finance_viewer: ["audit.log.read"],
  branch_manager: ["employee.pii.read", "attendance.approve"],
  line_manager: ["attendance.approve"],
  employee: [],
  it_security_admin: ["audit.log.read", "employee.pii.read"],
} as const satisfies Record<RoleCode, readonly PermissionAtom[]>;

export function roleHasPermission(role: RoleCode, atom: PermissionAtom): boolean {
  return rolePermissions[role].some((permission) => permission === atom);
}

/** Payroll and PII atoms are the routes a privileged role cannot call without TOTP. */
export function permissionRequiresPrivilegedTotp(atom: PermissionAtom): boolean {
  return atom.startsWith("employee.pii.") || atom.startsWith("payroll.");
}

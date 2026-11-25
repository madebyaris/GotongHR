export const permissionAtoms = [
  "employee.read",
  "employee.write",
  "employee.pii.read",
  "employee.pii.reveal",
  "attendance.approve",
  "payroll.run.prepare",
  "payroll.run.create",
  "payroll.run.finalize",
  "payroll.coretax.export",
  "ai.action.approve",
  "audit.log.read",
  "tenant.support_grant.write",
] as const;

export type PermissionAtom = (typeof permissionAtoms)[number];

const permissionAtomSet: ReadonlySet<string> = new Set(permissionAtoms);

export function isPermissionAtom(value: string): value is PermissionAtom {
  return permissionAtomSet.has(value);
}

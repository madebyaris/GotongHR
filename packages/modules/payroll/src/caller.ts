export interface PayrollCaller {
  tenantId: string;
  userId: string;
  role: string;
  permissions: readonly string[];
  employeeId: string | null;
  sessionTotpVerified: boolean;
  ipAddress: string | null;
  userAgent: string | null;
}

export function hasPermission(caller: PayrollCaller, atom: string): boolean {
  return caller.permissions.includes(atom);
}

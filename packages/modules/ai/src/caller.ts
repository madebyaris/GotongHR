import type { PermissionAtom } from "@gotonghr/contracts";

export interface AiCaller {
  tenantId: string;
  userId: string;
  role: string;
  permissions: readonly PermissionAtom[];
  scopeEntityIds: readonly string[];
  scopeBranchIds: readonly string[];
  directReportsOnly: boolean;
  selfOnly: boolean;
  selfEmployeeId: string | null;
  sessionTotpVerified: boolean;
}

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

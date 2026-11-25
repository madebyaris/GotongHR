export interface CoreHrAuth {
  tenantId: string;
  userId: string;
  role: string;
  permissions: readonly string[];
  scopeEntityIds: readonly string[];
  scopeBranchIds: readonly string[];
  directReportsOnly: boolean;
  selfOnly: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * Set from a support-grant session. `false` refuses reveal before any
   * plaintext is returned and before `aud_pii_access_logs` is written.
   */
  supportGrantAllowPiiReveal?: boolean;
}

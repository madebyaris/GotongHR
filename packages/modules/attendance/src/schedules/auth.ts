export interface AttendanceCaller {
  tenantId: string;
  userId: string;
  role: string;
  permissions: readonly string[];
  ipAddress: string | null;
  userAgent: string | null;
}

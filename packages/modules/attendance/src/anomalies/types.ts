export interface AnomalyCaller {
  tenantId: string;
  userId: string;
  role: string;
  permissions: readonly string[];
  scopeBranchIds: readonly string[];
  ipAddress: string | null;
  userAgent: string | null;
}

/** One punch still waiting for a manager. Both inbox routes return this shape. */
export interface PendingAnomaly {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  branchName: string;
  timezone: string;
  punchType: "clock_in" | "clock_out";
  capturedAt: string;
  clockDriftSeconds: number;
  distanceMeters: number | null;
  speedKmh: number | null;
  geofenceOk: boolean;
  livenessOk: boolean | null;
  mockLocationFlag: boolean;
  reasons: string[];
}

export interface ReviewedAnomaly {
  id: string;
  reviewStatus: "reviewed";
  reviewedBy: string;
  reviewedAt: string;
  reviewNote: string | null;
}

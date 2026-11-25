export interface ClockCaller {
  tenantId: string;
  userId: string;
  scopeBranchIds: readonly string[];
}

export type PunchType = "clock_in" | "clock_out";
export type SyncSource = "online" | "offline_queue";
export type ReviewStatus = "ok" | "needs_review" | "reviewed";

export interface ClockEventInput {
  idempotencyKey: string;
  employeeId: string;
  branchId: string | null;
  punchType: PunchType;
  capturedAt: Date;
  syncSource: SyncSource;
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  livenessOk: boolean | null;
  mockLocationFlag: boolean;
  selfieStorageKey: string | null;
}

export interface ClockDecision {
  id: string;
  idempotencyKey: string;
  duplicate: boolean;
  reviewStatus: ReviewStatus;
  reviewReasons: string[];
  geofenceOk: boolean;
  distanceMeters: number | null;
  clockDriftSeconds: number;
  speedKmh: number | null;
  capturedAt: string;
  receivedAt: string;
}

export interface SelfieUploadInput {
  contentType: "image/webp" | "image/jpeg";
  contentLength: number;
}

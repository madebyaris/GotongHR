export interface MobileCaller {
  tenantId: string;
  userId: string;
}

export interface BootstrapDay {
  date: string;
  code: string | null;
  start: string | null;
  end: string | null;
}

export interface BootstrapShift {
  code: string;
  name: string;
  start: string;
  end: string;
}

export interface BootstrapPayload {
  employee: {
    id: string;
    name: string;
    code: string;
    status: string;
  };
  branch: {
    id: string;
    name: string;
    timezone: string;
    lat: number | null;
    lng: number | null;
    radiusM: number | null;
  };
  shift: BootstrapShift | null;
  days: BootstrapDay[];
  leaveTypes: Array<{ code: string; name: string }>;
  balances: Array<{ code: string; year: number; entitled: number; used: number }>;
  punches: Array<{ type: string; at: string }>;
}

/** Seeded-fixture cap from the slice. The integration test fails above this. */
export const BOOTSTRAP_MAX_BYTES = 5 * 1024;

export const BOOTSTRAP_DAY_COUNT = 14;

import type { QueryClient } from "@tanstack/react-query";
import { readBootstrap, writeBootstrap } from "./db.js";

export class EssError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EssError";
    this.status = status;
  }
}

export interface EssEmployee {
  id: string;
  name: string;
  code: string;
  status: string;
}

export interface EssBranch {
  id: string;
  name: string;
  timezone: string;
  lat: number | null;
  lng: number | null;
  radiusM: number | null;
}

export interface EssShift {
  code: string;
  name: string;
  start: string;
  end: string;
}

export interface EssDay {
  date: string;
  code: string | null;
  start: string | null;
  end: string | null;
}

export interface EssBootstrap {
  employee: EssEmployee;
  branch: EssBranch;
  shift: EssShift | null;
  days: EssDay[];
  leaveTypes: Array<{ code: string; name: string }>;
  balances: Array<{ code: string; year: number; entitled: number; used: number }>;
  punches: Array<{ type: string; at: string }>;
}

export interface EssProfile {
  employee: EssEmployee;
  branch: EssBranch;
}

export interface EssShifts {
  shift: EssShift | null;
  days: EssDay[];
}

export interface EssToday {
  punches: EssBootstrap["punches"];
}

type SliceMap = {
  profile: EssProfile;
  shifts: EssShifts;
  leaveTypes: EssBootstrap["leaveTypes"];
  balances: EssBootstrap["balances"];
  today: EssToday;
};

export type SliceKey = keyof SliceMap;

const sliceKeys: SliceKey[] = ["profile", "shifts", "leaveTypes", "balances", "today"];

let memory: { etag: string | null; data: EssBootstrap } | null = null;
let inflight: Promise<EssBootstrap> | null = null;

export function splitBootstrap(data: EssBootstrap): SliceMap {
  return {
    profile: { employee: data.employee, branch: data.branch },
    shifts: { shift: data.shift, days: data.days },
    leaveTypes: data.leaveTypes,
    balances: data.balances,
    today: { punches: data.punches },
  };
}

export async function hydrateEss(client: QueryClient): Promise<void> {
  const stored = await readBootstrap().catch(() => null);
  if (!stored || !isBootstrap(stored.data)) return;
  memory = { etag: stored.etag, data: stored.data };
  const slices = splitBootstrap(stored.data);
  for (const key of sliceKeys) {
    client.setQueryData(["ess", key], slices[key], { updatedAt: stored.savedAt });
  }
}

export async function loadSlice<K extends SliceKey>(client: QueryClient, key: K): Promise<SliceMap[K]> {
  const data = await loadBootstrap();
  const slices = splitBootstrap(data);
  const now = Date.now();
  for (const sliceKey of sliceKeys) {
    if (sliceKey === key) continue;
    const state = client.getQueryState<SliceMap[typeof sliceKey]>(["ess", sliceKey]);
    const keep = state?.data !== undefined ? state.dataUpdatedAt : now;
    client.setQueryData(["ess", sliceKey], slices[sliceKey], { updatedAt: keep });
  }
  return slices[key];
}

function loadBootstrap(): Promise<EssBootstrap> {
  inflight ??= fetchBootstrap().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchBootstrap(): Promise<EssBootstrap> {
  let response: Response;
  try {
    response = await fetch("/api/v1/mobile/bootstrap", {
      credentials: "include",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(memory?.etag ? { "if-none-match": memory.etag } : {}),
      },
    });
  } catch {
    if (memory) return memory.data;
    throw new EssError(0, "You are offline.");
  }
  if (response.status === 304) {
    if (!memory) throw new EssError(0, "Shift data is missing. Reload.");
    return memory.data;
  }
  if (response.status === 401) throw new EssError(401, "Sign in to clock in.");
  const payload = (await response.json().catch(() => null)) as {
    data?: EssBootstrap;
    error?: { message?: string } | null;
  } | null;
  if (response.status === 404) {
    throw new EssError(404, payload?.error?.message ?? "No employee is linked to this sign-in.");
  }
  if (!response.ok || !payload || payload.error || !isBootstrap(payload.data)) {
    throw new EssError(response.status, payload?.error?.message ?? "Request failed.");
  }
  memory = { etag: response.headers.get("etag"), data: payload.data };
  await writeBootstrap({
    id: "current",
    etag: memory.etag,
    savedAt: Date.now(),
    data: payload.data,
  }).catch(() => undefined);
  return payload.data;
}

function isBootstrap(value: unknown): value is EssBootstrap {
  if (!value || typeof value !== "object") return false;
  const record = value as EssBootstrap;
  return typeof record.employee?.id === "string" && Array.isArray(record.days) && Array.isArray(record.punches);
}

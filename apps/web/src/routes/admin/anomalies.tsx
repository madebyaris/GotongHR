import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, apiData } from "@/lib/api";
import { AdminFrame } from "./frame";

interface PendingAnomaly {
  id: string;
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
  reasons: string[];
}

const PILL_LABELS: Record<string, string> = {
  geofence: "Geofence",
  missing_geofence: "Geofence",
  branch_mismatch: "Geofence",
  clock_drift: "Drift",
  travel_speed: "Speed",
  liveness: "Liveness",
  mock_location: "Mock",
};

export default function AnomaliesPage() {
  return (
    <AdminFrame wide>
      <AnomalyInbox />
    </AdminFrame>
  );
}

function AnomalyInbox() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const anomalies = useQuery({
    queryKey: ["attendance", "anomalies"],
    queryFn: () => apiData<PendingAnomaly[]>("/api/v1/attendance/anomalies"),
    retry: false,
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (anomalies.error instanceof ApiRequestError && anomalies.error.status === 401) {
      void navigate({ to: "/sign-in" });
    }
  }, [anomalies.error, navigate]);

  async function review(id: string): Promise<void> {
    setPendingId(id);
    setError(null);
    try {
      await apiData(`/api/v1/attendance/anomalies/${id}/review`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await queryClient.invalidateQueries({ queryKey: ["attendance", "anomalies"] });
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 401) {
        void navigate({ to: "/sign-in" });
        return;
      }
      setError(caught instanceof ApiRequestError ? caught.message : "The punch could not be reviewed.");
    } finally {
      setPendingId(null);
    }
  }

  const rows = anomalies.data ?? [];

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Anomalies</h1>
        {rows.length > 0 ? (
          <p className="text-sm text-muted-foreground">{rows.length} waiting</p>
        ) : null}
      </div>
      {anomalies.isPending ? <p className="mt-6 text-base text-muted-foreground">Loading punches…</p> : null}
      {anomalies.error && !(anomalies.error instanceof ApiRequestError && anomalies.error.status === 401) ? (
        <p className="mt-6 text-base" role="alert">
          Punches could not be loaded.
          <Button className="mt-4 min-h-11" type="button" onClick={() => void anomalies.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-base text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {anomalies.data && rows.length === 0 ? (
        <p className="mt-6 text-base" role="status">
          No punches need review.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <section aria-label="Punches needing review">
          <div className="mt-6 hidden border-b border-border pb-2 text-sm text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_11rem] sm:gap-4">
            <span>Employee</span>
            <span>Flag</span>
            <span className="text-right">Review</span>
          </div>
          <ul className="divide-y divide-border border-y border-border sm:border-t-0">
            {rows.map((row) => {
              const facts = detail(row);
              return (
                <li
                  className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_11rem] sm:items-center sm:gap-4"
                  key={row.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-medium">{row.employeeName}</p>
                    <p className="text-sm text-muted-foreground">
                      {row.employeeCode} · {row.branchName} · {punchLabel(row.punchType)} ·{" "}
                      {formatWhen(row.capturedAt, row.timezone)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-1">
                      {pills(row.reasons).map((label) => (
                        <span className="rounded-md border border-border px-2 py-0.5 text-sm" key={label}>
                          {label}
                        </span>
                      ))}
                    </div>
                    {facts ? <p className="mt-1 text-sm text-muted-foreground">{facts}</p> : null}
                  </div>
                  <Button
                    className="min-h-11 w-full"
                    disabled={pendingId !== null}
                    type="button"
                    onClick={() => void review(row.id)}
                  >
                    Mark reviewed
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function pills(reasons: string[]): string[] {
  const labels: string[] = [];
  for (const reason of reasons) {
    const label = PILL_LABELS[reason] ?? reason;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function punchLabel(punchType: PendingAnomaly["punchType"]): string {
  return punchType === "clock_out" ? "Out" : "In";
}

function detail(row: PendingAnomaly): string {
  const parts: string[] = [];
  const geofence =
    !row.geofenceOk ||
    row.reasons.some(
      (reason) => reason === "geofence" || reason === "missing_geofence" || reason === "branch_mismatch",
    );
  if (geofence) {
    parts.push(formatDistance(row.distanceMeters, row.geofenceOk));
  }
  if (row.reasons.includes("clock_drift")) parts.push(formatDrift(row.clockDriftSeconds));
  if (row.reasons.includes("travel_speed") && row.speedKmh !== null) {
    parts.push(`${Math.round(row.speedKmh)} km/h`);
  }
  return parts.join(" · ");
}

function formatDistance(meters: number | null, inside: boolean): string {
  if (meters === null) return "Distance unknown";
  const place = inside ? "from branch" : "outside";
  if (meters >= 1000) {
    const km = meters / 1000;
    const rounded = km >= 10 ? String(Math.round(km)) : String(Math.round(km * 10) / 10);
    return `${rounded} km ${place}`;
  }
  return `${Math.round(meters)} m ${place}`;
}

function formatDrift(seconds: number): string {
  const early = seconds < 0;
  const abs = Math.abs(Math.round(seconds));
  const body = abs < 60 ? `${abs} sec` : abs < 3600 ? `${Math.round(abs / 60)} min` : formatHours(abs);
  return early ? `${body} early` : `${body} drift`;
}

function formatHours(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

function formatWhen(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "Asia/Jakarta" }).format(date);
  }
}

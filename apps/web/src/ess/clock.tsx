import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { EssError, loadSlice, type EssBranch, type EssShifts, type EssToday } from "./cache";
import { listOutbox, putOutbox, type OutboxClockEvent } from "./db.js";
import { nextPunch, STALE_MS, uuidv7 } from "./policy";
import { compressSelfie } from "./selfie";
import { registerBackgroundSync, requestFlush } from "./sync";

const GPS_TIMEOUT_MS = 4_000;

export function ClockScreen() {
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ["ess", "profile"],
    staleTime: STALE_MS.profile,
    queryFn: () => loadSlice(client, "profile"),
  });
  const shifts = useQuery({
    queryKey: ["ess", "shifts"],
    staleTime: STALE_MS.shifts,
    queryFn: () => loadSlice(client, "shifts"),
  });
  useQuery({
    queryKey: ["ess", "leaveTypes"],
    staleTime: STALE_MS.leaveTypes,
    queryFn: () => loadSlice(client, "leaveTypes"),
  });
  useQuery({
    queryKey: ["ess", "balances"],
    staleTime: STALE_MS.balances,
    queryFn: () => loadSlice(client, "balances"),
  });
  const today = useQuery({
    queryKey: ["ess", "today"],
    staleTime: STALE_MS.today,
    queryFn: () => loadSlice(client, "today"),
  });
  const [pending, setPending] = useState<OutboxClockEvent[]>([]);
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void listOutbox()
        .then((rows) => {
          if (live) setPending(rows);
        })
        .catch(() => undefined);
    };
    const onOnline = () => {
      setOffline(false);
      void requestFlush().then(refresh);
    };
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void requestFlush().then(refresh);
    return () => {
      live = false;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const loadError = firstError(profile.error, shifts.error, today.error);
  if (loadError) return <ClockMessage message={loadError} />;
  if (!profile.data || !shifts.data || !today.data) return <ClockMessage message="Loading your shift…" />;

  const rows = mergePunches(today.data, pending);
  const last = rows[rows.length - 1] ?? null;
  const next = nextPunch(last?.type ?? null);
  const active = profile.data.employee.status === "active";
  const zone = profile.data.branch.timezone || "Asia/Jakarta";

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !profile.data) return;
    setSaving(true);
    setError(null);
    try {
      const image = await compressSelfie(file);
      const point = (await readGps()) ?? branchPoint(profile.data.branch);
      if (!point) throw new Error("Turn on location to clock in.");
      const queued: OutboxClockEvent = {
        idempotency_key: uuidv7(),
        employee_id: profile.data.employee.id,
        punch_type: next,
        captured_at: new Date().toISOString(),
        monotonic_elapsed_ms: Math.round(performance.now()),
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
        mock_location_flags: { mocked: point.mocked, source: point.source },
        selfie_blob: image.blob,
        selfie_type: image.type,
        sync_source: navigator.onLine ? "online" : "offline_queue",
      };
      await putOutbox(queued);
      setPending(await listOutbox());
      await requestFlush();
      setPending(await listOutbox());
      await client.invalidateQueries({ queryKey: ["ess", "today"] });
      await registerBackgroundSync();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Choose a selfie under 40 KB.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="clock-screen">
      <p className="clock-brand-row">
        <span className="clock-brand">GotongHR</span>
        {offline ? <span className="clock-offline">Offline</span> : null}
      </p>
      <h1>{profile.data.employee.name}</h1>
      <p className="clock-muted">{formatDay(zone)}</p>
      <p className="clock-status" role="status">
        {statusLine(last, zone)}
      </p>
      <p className="clock-shift">{shiftLine(shifts.data)}</p>
      {pending.length > 0 ? (
        <p className="clock-queue" role="status">
          {pending.length === 1 ? "1 punch waiting to sync" : `${pending.length} punches waiting to sync`}
        </p>
      ) : null}
      {active ? (
        <button className="clock-action" type="button" disabled={saving} onClick={() => fileRef.current?.click()}>
          {saving ? "Saving…" : next === "clock_in" ? "Clock in" : "Clock out"}
        </button>
      ) : (
        <p className="clock-alert" role="alert">
          This record is not active.
        </p>
      )}
      <label className="clock-selfie">
        Selfie
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="user"
          onChange={(event) => void onFile(event)}
        />
      </label>
      {error ? (
        <p className="clock-alert" role="alert">
          {error}
        </p>
      ) : null}
      <h2>Today</h2>
      {rows.length === 0 ? <p className="clock-muted">No punches yet</p> : null}
      <ul className="clock-punches">
        {rows.map((row) => (
          <li key={row.key}>{punchLine(row, zone)}</li>
        ))}
      </ul>
    </main>
  );
}

function ClockMessage({ message }: { message: string }) {
  const signedOut = message === "Sign in to clock in.";
  return (
    <main className="clock-screen">
      <p className="clock-brand">GotongHR</p>
      <p className="clock-status" role="status">
        {message}
      </p>
      {signedOut ? <a href="/sign-in">Sign in</a> : null}
    </main>
  );
}

function firstError(...errors: unknown[]): string | null {
  for (const error of errors) {
    if (error instanceof EssError) return error.message;
    if (error instanceof Error) return error.message;
  }
  return null;
}

interface ShownPunch {
  type: "clock_in" | "clock_out";
  at: string;
  waiting: boolean;
  key: string;
}

function mergePunches(today: EssToday, pending: readonly OutboxClockEvent[]): ShownPunch[] {
  const rows: ShownPunch[] = [
    ...today.punches.map((punch) => ({
      type: punch.type === "clock_out" ? ("clock_out" as const) : ("clock_in" as const),
      at: punch.at,
      waiting: false,
      key: `${punch.at}-${punch.type}`,
    })),
    ...pending.map((event) => ({
      type: event.punch_type,
      at: event.captured_at,
      waiting: true,
      key: event.idempotency_key,
    })),
  ];
  rows.sort((left, right) => left.at.localeCompare(right.at));
  return rows;
}

function statusLine(last: ShownPunch | null, timeZone: string): string {
  if (!last) return "Not clocked in";
  const when = formatTime(last.at, timeZone);
  return last.type === "clock_out" ? `Clocked out at ${when}` : `Clocked in at ${when}`;
}

function shiftLine(shifts: EssShifts): string {
  if (!shifts.shift) return "No shift today";
  return `${shifts.shift.name}, ${shifts.shift.start} to ${shifts.shift.end}`;
}

function punchLine(punch: ShownPunch, timeZone: string): string {
  const label = punch.type === "clock_out" ? "clock out" : "clock in";
  const waiting = punch.waiting ? ", waiting" : "";
  return `${formatTime(punch.at, timeZone)} ${label}${waiting}`;
}

function formatTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatDay(timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date());
}

interface Point {
  lat: number;
  lng: number;
  accuracy: number | null;
  mocked: boolean;
  source: "gps" | "branch";
}

function readGps(): Promise<Point | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), GPS_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(timer);
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          mocked: false,
          source: "gps",
        });
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30_000 },
    );
  });
}

function branchPoint(branch: EssBranch): Point | null {
  if (branch.lat === null || branch.lng === null) return null;
  return { lat: branch.lat, lng: branch.lng, accuracy: null, mocked: true, source: "branch" };
}

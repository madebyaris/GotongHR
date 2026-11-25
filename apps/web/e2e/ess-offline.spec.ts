import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Drives features 05 and 06.
 * The API must already be on port 3000 with BETTER_AUTH_URL set to the browser origin.
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:5173 pnpm --filter @gotonghr/web exec playwright test e2e/ess-offline.spec.ts
 */

const email = process.env.GOTONG_E2E_EMAIL ?? "owner@gotonghr.local";
const password = process.env.GOTONG_E2E_PASSWORD ?? "change-me-owner-password";
const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";
const media = "/cursor/stores/self/media";
const nik = "3273012001900002";
const selfiePng = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000020000000200802000000fc18eda30000002a4944415478da63d0885a4053c4306ac1a805a3168c5a306ac1a805a3168c5a306ac1a805a3160c150b004828883df1892a970000000049454e44ae426082",
  "hex",
);

test.use({
  viewport: { width: 390, height: 844 },
  geolocation: { latitude: -6.175392, longitude: 106.827153 },
  permissions: ["geolocation"],
});

test.beforeAll(async ({ request }) => {
  await cleanupEmployee();
  await signInRequest(request);
  await ensureCompany(request);
  await ensureEmployee(request);
  await ensureShiftAndRoster(request);
  await linkEmployee();
});

test.afterAll(async () => {
  await cleanupEmployee();
});

test("bootstrap shows the shift and answers 304", async ({ page }) => {
  await openClock(page);
  await expect(page.getByRole("heading", { name: "Sari Wulandari" })).toBeVisible();
  await expect(page.getByText("GotongHR").first()).toBeVisible();
  await expect(page.getByText("Not clocked in")).toBeVisible();
  await expect(page.getByText("Pagi, 08:00 to 17:00")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clock in" })).toBeVisible();
  await saveShot(page, "slice-3-3-ess-clock-phone.png");

  const first = await page.request.get("/api/v1/mobile/bootstrap", { headers: { origin } });
  const raw = await first.text();
  expect(first.ok(), raw).toBe(true);
  expect(Buffer.byteLength(raw)).toBeLessThan(5 * 1024);
  const etag = first.headers().etag;
  expect(etag).toBeTruthy();
  const again = await page.request.get("/api/v1/mobile/bootstrap", {
    headers: { origin, "if-none-match": etag ?? "" },
  });
  expect(again.status()).toBe(304);
  expect((await again.body()).length).toBe(0);
});

test("offline punch syncs once", async ({ page }) => {
  await openClock(page);
  await expect(page.getByRole("button", { name: "Clock in" })).toBeVisible();
  const syncBodies: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/v1/mobile/attendance/sync")) {
      syncBodies.push(request.postData() ?? "");
    }
  });

  await page.context().setOffline(true);
  await expect(page.getByText("Offline")).toBeVisible();
  const selfie = path.join(tmpdir(), "gotonghr-selfie.png");
  await writeFile(selfie, selfiePng);
  await page.getByLabel("Selfie").setInputFiles(selfie);
  await expect(page.getByText("1 punch waiting to sync")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clock out" })).toBeVisible();

  const queued = await page.evaluate(readOutbox);
  expect(queued).toHaveLength(1);
  const row = queued[0];
  expect(row?.punch_type).toBe("clock_in");
  expect(row?.idempotency_key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(row?.captured_at).toContain("T");
  expect(typeof row?.monotonic_elapsed_ms).toBe("number");
  expect(typeof row?.lat).toBe("number");
  expect(typeof row?.lng).toBe("number");
  expect(row?.accuracy === null || typeof row?.accuracy === "number").toBe(true);
  expect(typeof row?.mock_location_flags.mocked).toBe("boolean");
  expect(row?.selfie_bytes ?? 0).toBeGreaterThan(0);
  expect(row?.selfie_bytes ?? 0).toBeLessThan(40 * 1024);
  expect(["image/webp", "image/jpeg"]).toContain(row?.selfie_type);
  await saveShot(page, "slice-3-3-ess-offline-phone.png");

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const key = row?.idempotency_key ?? "";
  await expect.poll(() => punchCount(key), { timeout: 20_000 }).toBe(1);
  expect(syncBodies.length).toBeGreaterThan(0);
  const replay = await page.request.post("/api/v1/mobile/attendance/sync", {
    headers: { origin, "content-type": "application/json" },
    data: JSON.parse(syncBodies.at(-1) ?? "{}") as unknown,
  });
  expect(replay.ok(), await replay.text()).toBe(true);
  expect(await punchCount(key)).toBe(1);
});

async function openClock(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Set up the company" })).toBeVisible();
  await page.goto("/ess");
}

async function signInRequest(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/auth/sign-in/email", {
    headers: { origin },
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function ensureCompany(request: APIRequestContext): Promise<void> {
  const context = await request.get("/api/v1/me/context", { headers: { origin } });
  expect(context.ok(), await context.text()).toBe(true);
  const body = (await context.json()) as {
    data: { legalEntities: { id: string }[]; branches: { id: string }[] };
  };
  let branchId = body.data.branches[0]?.id;
  if (!body.data.legalEntities[0] || !branchId) {
    const entity = await request.post("/api/v1/legal-entities", {
      headers: { origin },
      data: { companyName: "PT Surya Nusantara", npwp16: "0123456789012345" },
    });
    expect(entity.ok(), await entity.text()).toBe(true);
    const created = (await entity.json()) as { data: { id: string } };
    const branch = await request.post("/api/v1/branches", {
      headers: { origin },
      data: {
        legalEntityId: created.data.id,
        name: "Jakarta Pusat",
        nitku22: "0123456789012345678901",
        timezone: "Asia/Jakarta",
        umpUmkIdr: "5396761",
        latitude: "-6.175392",
        longitude: "106.827153",
        geofenceRadiusM: 120,
      },
    });
    expect(branch.ok(), await branch.text()).toBe(true);
    branchId = ((await branch.json()) as { data: { id: string } }).data.id;
  }
  const patched = await request.patch(`/api/v1/branches/${branchId}`, {
    headers: { origin },
    data: {
      latitude: "-6.175392",
      longitude: "106.827153",
      geofenceRadiusM: 120,
      timezone: "Asia/Jakarta",
    },
  });
  expect(patched.ok(), await patched.text()).toBe(true);
}

async function ensureEmployee(request: APIRequestContext): Promise<void> {
  const context = await request.get("/api/v1/me/context", { headers: { origin } });
  const body = (await context.json()) as {
    data: { legalEntities: { id: string }[]; branches: { id: string }[] };
  };
  const created = await request.post("/api/v1/employees", {
    headers: { origin },
    data: {
      employeeCode: "ESS01",
      fullName: "Sari Wulandari",
      legalEntityId: body.data.legalEntities[0]?.id,
      branchId: body.data.branches[0]?.id,
      employmentStatus: "active",
      joinDate: "2024-03-01",
      ptkpStatus: "TK/0",
      taxMethod: "gross",
      pph21SubjectType: "permanent",
      nik,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

async function ensureShiftAndRoster(request: APIRequestContext): Promise<void> {
  const listed = await request.get("/api/v1/shifts", { headers: { origin } });
  expect(listed.ok(), await listed.text()).toBe(true);
  const shifts = (await listed.json()) as { data: { id: string; code: string }[] };
  let shiftId = shifts.data.find((shift) => shift.code === "PAGI")?.id;
  if (!shiftId) {
    const created = await request.post("/api/v1/shifts", {
      headers: { origin },
      data: {
        code: "PAGI",
        name: "Pagi",
        startLocalTime: "08:00",
        endLocalTime: "17:00",
        graceMinutes: 10,
        workweekType: "5_day",
        isOvernight: false,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    shiftId = ((await created.json()) as { data: { id: string } }).data.id;
  }
  const employee = await employeeId();
  const today = jakartaToday();
  const assigned = await request.post("/api/v1/rosters/bulk", {
    headers: { origin },
    data: {
      assignments: datesFrom(today, 14).map((workDate) => ({ employeeId: employee, shiftId, workDate })),
    },
  });
  expect(assigned.ok(), await assigned.text()).toBe(true);
}

async function linkEmployee(): Promise<void> {
  const client = await openSuperuser();
  try {
    const linked = await client.query(
      `UPDATE hr_employees AS e
       SET user_id = u.id
       FROM id_users AS u
       WHERE u.email = $1
         AND e.employee_code = 'ESS01'
         AND e.tenant_id = u.tenant_id`,
      [email],
    );
    expect(linked.rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

async function employeeId(): Promise<string> {
  const client = await openSuperuser();
  try {
    const found = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM hr_employees WHERE employee_code = 'ESS01'",
    );
    const id = found.rows[0]?.id;
    if (!id) throw new Error("ESS01 was not created.");
    return id;
  } finally {
    await client.end();
  }
}

async function punchCount(key: string): Promise<number> {
  const client = await openSuperuser();
  try {
    const found = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM att_clock_events WHERE idempotency_key = $1::uuid",
      [key],
    );
    return Number(found.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function cleanupEmployee(): Promise<void> {
  const client = await openSuperuser();
  try {
    await client.query(
      `DELETE FROM att_clock_events
       WHERE employee_id IN (SELECT id FROM hr_employees WHERE employee_code = 'ESS01')`,
    );
    await client.query(
      `DELETE FROM att_rosters
       WHERE employee_id IN (SELECT id FROM hr_employees WHERE employee_code = 'ESS01')`,
    );
    await client.query(
      `DELETE FROM att_leave_balances
       WHERE employee_id IN (SELECT id FROM hr_employees WHERE employee_code = 'ESS01')`,
    );
    await client.query(
      `DELETE FROM hr_employee_pii
       WHERE employee_id IN (SELECT id FROM hr_employees WHERE employee_code = 'ESS01')`,
    );
    await client.query("DELETE FROM hr_employees WHERE employee_code = 'ESS01'");
  } finally {
    await client.end();
  }
}

async function openSuperuser(): Promise<pg.Client> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  process.loadEnvFile(path.join(root, ".env"));
  const connectionString = process.env.DATABASE_URL_SUPERUSER;
  if (!connectionString) throw new Error("DATABASE_URL_SUPERUSER is required.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function saveShot(page: Page, name: string): Promise<void> {
  await mkdir(media, { recursive: true });
  const file = path.join(media, name);
  await page.screenshot({ path: file });
  const info = await stat(file);
  expect(info.size).toBeGreaterThan(5_000);
}

function readOutbox(): Promise<
  Array<{
    idempotency_key?: string;
    punch_type?: string;
    captured_at?: string;
    monotonic_elapsed_ms?: number;
    lat?: number;
    lng?: number;
    accuracy?: number | null;
    mock_location_flags: { mocked?: boolean };
    selfie_bytes?: number;
    selfie_type?: string;
  }>
> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gotonghr-ess");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("outbox_clock_events", "readonly");
      const read = tx.objectStore("outbox_clock_events").getAll();
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        const rows = read.result as Array<Record<string, unknown>>;
        resolve(
          rows.map((row) => {
            const blob = row.selfie_blob;
            const flags = row.mock_location_flags as { mocked?: boolean };
            return {
              idempotency_key: String(row.idempotency_key),
              punch_type: String(row.punch_type),
              captured_at: String(row.captured_at),
              monotonic_elapsed_ms: Number(row.monotonic_elapsed_ms),
              lat: Number(row.lat),
              lng: Number(row.lng),
              accuracy: row.accuracy === null ? null : Number(row.accuracy),
              mock_location_flags: { mocked: flags.mocked },
              selfie_bytes: blob instanceof Blob ? blob.size : 0,
              selfie_type: blob instanceof Blob ? blob.type : "",
            };
          }),
        );
      };
    };
  });
}

function jakartaToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function datesFrom(start: string, count: number): string[] {
  const [year, month, day] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const utc = new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1, (day ?? 1) + index));
    return utc.toISOString().slice(0, 10);
  });
}

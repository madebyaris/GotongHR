import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

/**
 * A manager sees one flagged punch, marks it reviewed, and reloads an empty inbox.
 * The API must already be on port 3000 with BETTER_AUTH_URL set to the web origin.
 *   GOTONG_SCREENSHOT_DIR=/cursor/stores/self/media pnpm --filter @gotonghr/web exec playwright test e2e/anomalies.spec.ts
 */

const email = process.env.GOTONG_E2E_EMAIL ?? "owner@gotonghr.local";
const password = process.env.GOTONG_E2E_PASSWORD ?? "change-me-owner-password";
const shotDir = process.env.GOTONG_SCREENSHOT_DIR;
const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";
const employeeName = "Raka Putra";
const employeeCode = "AN001";
const nik = "3273011508960002";

test("manager reviews a flagged punch and it stays off the inbox", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const place = await ensureCompany(page);
  const employeeId = await ensureEmployee(page, place);
  await clearPunches(place.tenantId);
  const synced = await syncPunches(page.request, employeeId);
  expect(synced.inside.reviewStatus, JSON.stringify(synced.inside)).toBe("ok");
  expect(synced.flagged.reviewStatus, JSON.stringify(synced.flagged)).toBe("needs_review");
  expect(synced.flagged.reviewReasons).toContain("geofence");

  const before = await page.request.get("/api/v1/attendance/anomalies", { headers: { origin } });
  const phone = await page.request.get("/api/v1/mobile/approvals/pending", { headers: { origin } });
  const beforeText = await before.text();
  const phoneText = await phone.text();
  expect(before.ok(), beforeText).toBe(true);
  expect(phoneText).toBe(beforeText);
  const pendingIds = idsOf(JSON.parse(beforeText) as { data?: { id?: string }[] });
  expect(pendingIds).toContain(synced.flagged.id);
  expect(pendingIds).not.toContain(synced.inside.id);

  await page.goto("/admin/anomalies");
  await expect(page.getByRole("heading", { name: "Anomalies" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Anomalies" })).toBeVisible();
  await expect(page.getByText(employeeName)).toBeVisible();
  await expect(page.getByText("Geofence")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(1);
  await shot(page, "slice-3-4-anomalies-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-3-4-anomalies-phone.png");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.getByRole("status")).toHaveText("No punches need review.");
  await expect(page.getByText(employeeName)).toHaveCount(0);
  await shot(page, "slice-3-4-anomalies-empty-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-3-4-anomalies-empty-phone.png");

  await page.reload();
  await expect(page.getByRole("status")).toHaveText("No punches need review.");
  await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);
  const after = await page.request.get("/api/v1/attendance/anomalies", { headers: { origin } });
  const afterPhone = await page.request.get("/api/v1/mobile/approvals/pending", { headers: { origin } });
  const afterText = await after.text();
  expect(await afterPhone.text()).toBe(afterText);
  expect(idsOf(JSON.parse(afterText) as { data?: { id?: string }[] })).not.toContain(synced.flagged.id);
  await expectReviewed(synced.flagged.id);
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Set up the company" })).toBeVisible();
}

async function ensureCompany(page: Page): Promise<{ tenantId: string; legalEntityId: string; branchId: string }> {
  const context = await page.request.get("/api/v1/me/context", { headers: { origin } });
  expect(context.ok(), await context.text()).toBe(true);
  const body = (await context.json()) as {
    data: {
      tenant: { id: string };
      legalEntities: { id: string }[];
      branches: { id: string }[];
    };
  };
  let legalEntityId = body.data.legalEntities[0]?.id;
  let branchId = body.data.branches[0]?.id;
  if (!legalEntityId) {
    const entity = await page.request.post("/api/v1/legal-entities", {
      headers: { origin },
      data: { companyName: "PT Surya Nusantara", npwp16: "0123456789012345" },
    });
    expect(entity.ok(), await entity.text()).toBe(true);
    legalEntityId = ((await entity.json()) as { data: { id: string } }).data.id;
  }
  if (!branchId) {
    const branch = await page.request.post("/api/v1/branches", {
      headers: { origin },
      data: {
        legalEntityId,
        name: "Jakarta Pusat",
        nitku22: "0123456789012345678901",
        timezone: "Asia/Jakarta",
        umpUmkIdr: "5396761",
        latitude: "-6.200000",
        longitude: "106.816000",
        geofenceRadiusM: 200,
      },
    });
    expect(branch.ok(), await branch.text()).toBe(true);
    branchId = ((await branch.json()) as { data: { id: string } }).data.id;
  }
  const placed = await page.request.patch(`/api/v1/branches/${branchId}`, {
    headers: { origin },
    data: { latitude: "-6.200000", longitude: "106.816000", geofenceRadiusM: 200 },
  });
  expect(placed.ok(), await placed.text()).toBe(true);
  return { tenantId: body.data.tenant.id, legalEntityId, branchId };
}

async function ensureEmployee(
  page: Page,
  place: { legalEntityId: string; branchId: string },
): Promise<string> {
  const listed = await page.request.get("/api/v1/employees", { headers: { origin } });
  expect(listed.ok(), await listed.text()).toBe(true);
  const employees = (await listed.json()) as { data: { id: string; employeeCode: string }[] };
  const existing = employees.data.find((row) => row.employeeCode === employeeCode);
  if (existing) return existing.id;
  const created = await page.request.post("/api/v1/employees", {
    headers: { origin },
    data: {
      fullName: employeeName,
      employeeCode,
      legalEntityId: place.legalEntityId,
      branchId: place.branchId,
      nik,
      joinDate: "2024-01-15",
      employmentStatus: "active",
      ptkpStatus: "TK/0",
      taxMethod: "gross",
      pph21SubjectType: "permanent",
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { data: { id: string } }).data.id;
}

async function syncPunches(request: APIRequestContext, employeeId: string): Promise<{
  inside: ClockDecision;
  flagged: ClockDecision;
}> {
  const capturedAt = new Date(Date.now() - 2000).toISOString();
  const response = await request.post("/api/v1/mobile/attendance/sync", {
    headers: { origin },
    data: {
      events: [
        punch(employeeId, capturedAt, -6.2, 106.816),
        punch(employeeId, capturedAt, -6.21, 106.816),
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const events = ((await response.json()) as { data: { events: ClockDecision[] } }).data.events;
  const inside = events.find((event) => event.reviewStatus === "ok");
  const flagged = events.find((event) => event.reviewStatus === "needs_review");
  expect(inside, JSON.stringify(events)).toBeTruthy();
  expect(flagged, JSON.stringify(events)).toBeTruthy();
  return { inside: inside as ClockDecision, flagged: flagged as ClockDecision };
}

async function clearPunches(tenantId: string): Promise<void> {
  const client = await openSuperuser();
  try {
    await client.query("DELETE FROM att_clock_events WHERE tenant_id = $1::uuid", [tenantId]);
  } finally {
    await client.end();
  }
}

async function expectReviewed(id: string): Promise<void> {
  const client = await openSuperuser();
  try {
    const row = await client.query<{ review_status: string; reviewed: boolean }>(
      `SELECT review_status, reviewed_at IS NOT NULL AS reviewed
       FROM att_clock_events WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]?.review_status).toBe("reviewed");
    expect(row.rows[0]?.reviewed).toBe(true);
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

async function shot(page: Page, name: string): Promise<void> {
  if (!shotDir) return;
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, name), fullPage: true });
}

function punch(employeeId: string, capturedAt: string, lat: number, lng: number) {
  return {
    idempotencyKey: uuidv7(),
    employeeId,
    punchType: "clock_in",
    capturedAt,
    syncSource: "online",
    lat,
    lng,
    livenessOk: true,
    mockLocationFlag: false,
  };
}

function idsOf(body: { data?: { id?: string }[] }): string[] {
  return (body.data ?? []).flatMap((row) => (row.id ? [row.id] : []));
}

interface ClockDecision {
  id: string;
  reviewStatus: string;
  reviewReasons: string[];
}

function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(randomBytes(16));
  const time = BigInt(now);
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

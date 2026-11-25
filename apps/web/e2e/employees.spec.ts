import { createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Creates an employee, reloads the masked NIK, and reveals it once.
 * The API must already be on port 3000 with BETTER_AUTH_URL set to the web origin.
 *   GOTONG_SCREENSHOT_DIR=/cursor/stores/self/media pnpm --filter @gotonghr/web exec playwright test e2e/employees.spec.ts
 */

const email = process.env.GOTONG_E2E_EMAIL ?? "owner@gotonghr.local";
const password = process.env.GOTONG_E2E_PASSWORD ?? "change-me-owner-password";
const shotDir = process.env.GOTONG_SCREENSHOT_DIR;
const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";
const nik = "3273011508950001";
const badNik = "3273013208950001";
const mask = "3273********0001";

test.beforeAll(async () => {
  await resetEmployees();
});

test.afterAll(async () => {
  await clearOwnerTotp();
});

test("owner adds an employee, keeps the masked NIK, and reveals it once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await ensureCompany(page);
  await page.goto("/admin/employees");
  await expect(page.getByRole("heading", { name: "Employees" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("No employees yet.");
  await shot(page, "slice-2-1-empty-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-2-1-empty-phone.png");

  await page.setViewportSize({ width: 1440, height: 900 });
  await fillEmployee(page, badNik);
  await page.getByRole("button", { name: "Add employee" }).click();
  await expect(page.getByRole("alert")).toContainText("Check the highlighted fields.");
  await expect(page.getByText("NIK birth date is not a real date.")).toBeVisible();
  await shot(page, "slice-2-1-error-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-2-1-error-phone.png");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("NIK").fill(nik);
  await page.getByRole("button", { name: "Add employee" }).click();
  await expect(page.getByRole("status")).toContainText("Saved. Sari Wulandari.");
  await expect(page.getByText(mask)).toBeVisible();
  await expect(page.getByText(nik)).toHaveCount(0);
  await shot(page, "slice-2-1-saved-wide.png");

  await page.reload();
  await expect(page.getByText(mask)).toBeVisible();
  await expect(page.getByText(nik)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-2-1-saved-phone.png");

  await page.setViewportSize({ width: 1440, height: 900 });
  await enrollTotp(page);
  await page.getByRole("button", { name: "Reveal NIK" }).click();
  await page.getByLabel("Reason").fill("BPJS registration");
  await page.getByRole("button", { name: "Show NIK" }).click();
  await expect(page.getByText(`NIK ${nik}`)).toBeVisible();
  await expect(page.locator("td").getByText(mask)).toBeVisible();
  await assertRevealLog();
});

async function fillEmployee(page: Page, value: string): Promise<void> {
  await page.getByLabel("Full name").fill("Sari Wulandari");
  await page.getByLabel("Employee code").fill("E001");
  await page.getByLabel("NIK").fill(value);
}

async function ensureCompany(page: Page): Promise<void> {
  const context = await page.request.get("/api/v1/me/context", { headers: { origin } });
  expect(context.ok()).toBe(true);
  const body = (await context.json()) as {
    data: { legalEntities: { id: string }[]; branches: { id: string }[] };
  };
  if (body.data.legalEntities.length > 0 && body.data.branches.length > 0) return;
  const entity = await page.request.post("/api/v1/legal-entities", {
    headers: { origin },
    data: { companyName: "PT Surya Nusantara", npwp16: "0123456789012345" },
  });
  expect(entity.ok(), await entity.text()).toBe(true);
  const created = (await entity.json()) as { data: { id: string } };
  const branch = await page.request.post("/api/v1/branches", {
    headers: { origin },
    data: {
      legalEntityId: created.data.id,
      name: "Jakarta Pusat",
      nitku22: "0123456789012345678901",
      timezone: "Asia/Jakarta",
      umpUmkIdr: "5396761",
    },
  });
  expect(branch.ok(), await branch.text()).toBe(true);
}

async function enrollTotp(page: Page): Promise<void> {
  const enabled = await page.request.post("/api/auth/two-factor/enable", {
    headers: { origin },
    data: { password },
  });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  const enrollment = (await enabled.json()) as { totpURI?: string };
  if (!enrollment.totpURI) throw new Error("TOTP enrollment did not return a secret.");
  const verified = await page.request.post("/api/auth/two-factor/verify-totp", {
    headers: { origin },
    data: { code: totpFromUri(enrollment.totpURI) },
  });
  expect(verified.ok(), await verified.text()).toBe(true);
}

async function assertRevealLog(): Promise<void> {
  const client = await openSuperuser();
  try {
    const logs = await client.query<{ row_text: string }>(
      `SELECT row_to_json(aud_pii_access_logs)::text AS row_text
       FROM aud_pii_access_logs
       WHERE reason = 'BPJS registration'`,
    );
    expect(logs.rowCount).toBe(1);
    expect(logs.rows[0]?.row_text.includes(nik)).toBe(false);
    const stored = await client.query<{ nik_enc: string }>(
      "SELECT nik_enc FROM hr_employee_pii WHERE nik_mask = $1",
      [mask],
    );
    expect(stored.rows.some((row) => row.nik_enc === nik)).toBe(false);
  } finally {
    await client.end();
  }
}

async function clearOwnerTotp(existing?: pg.Client): Promise<void> {
  const client = existing ?? (await openSuperuser());
  try {
    await client.query(`UPDATE ba_user SET two_factor_enabled = false WHERE email = $1`, [email]);
    await client.query(
      `DELETE FROM ba_two_factor
       WHERE user_id = (SELECT id FROM ba_user WHERE email = $1)`,
      [email],
    );
    await client.query(
      `UPDATE id_sessions SET totp_verified_at = NULL
       WHERE auth_user_id = (SELECT id FROM ba_user WHERE email = $1)`,
      [email],
    );
  } finally {
    if (!existing) await client.end();
  }
}

async function resetEmployees(): Promise<void> {
  const client = await openSuperuser();
  try {
    await client.query(
      `TRUNCATE TABLE
         hr_contract_expiry_notices,
         hr_compensation_profiles,
         hr_contracts,
         hr_documents,
         hr_employee_pii,
         hr_employees,
         hr_positions,
         hr_departments`,
    );
    await client.query("DELETE FROM aud_pii_access_logs WHERE reason = 'BPJS registration'");
    await clearOwnerTotp(client);
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

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Set up the company" })).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotDir) return;
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, name), fullPage: true });
}

function totpFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("missing totp secret");
  return totpCode(base32Decode(secret), Date.now());
}

function totpCode(secret: Buffer, at: number): string {
  const counter = Math.floor(at / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/=+$/u, "").toUpperCase().replace(/ /gu, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

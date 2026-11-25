import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Signs in, asks the fake provider for a display-name change, and confirms it.
 * The API must already be on port 3000 with BETTER_AUTH_URL set to the web origin.
 *   GOTONG_SCREENSHOT_DIR=/path pnpm --filter @gotonghr/web test:e2e e2e/assistant.spec.ts
 */

const email = process.env.GOTONG_E2E_EMAIL ?? "owner@gotonghr.local";
const password = process.env.GOTONG_E2E_PASSWORD ?? "change-me-owner-password";
const shotDir = process.env.GOTONG_SCREENSHOT_DIR;
const employeeId = "11111111-1111-4111-8111-111111111111";
const nik = "3175012345670001";

test.beforeAll(async () => {
  await resetAssistant();
});

test("admin confirms a proposal, reloads it, and leaves an audit row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByRole("link", { name: "Assistant" }).click();
  await expect(page.getByRole("heading", { name: "Assistant" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("not official statute text");
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await shot(page, "slice-5-3-notice-wide.png");
  await shot(page, "slice-5-2-empty-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-5-3-notice-phone.png");
  await shot(page, "slice-5-2-empty-phone.png");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("Message").fill(`Propose display name Sari for employee ${employeeId}. NIK ${nik}`);
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByRole("article");
  await expect(card).toContainText("Display name");
  await expect(card).toContainText("Sari");
  await expect(card).toContainText("No rupiah or day change.");
  await expect(card).toContainText("Nothing changes until you confirm.");
  await expect(card.getByRole("button", { name: "Confirm" })).toBeEnabled();
  await expect(page.locator("body")).not.toContainText(nik);
  await shot(page, "slice-5-2-proposal-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-5-2-proposal-phone.png");

  await page.setViewportSize({ width: 1440, height: 900 });
  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card).toContainText("Confirmed. The decision is saved in the audit log.");
  await expect(card).toContainText("Sari");
  await expect(page.locator("body")).not.toContainText(nik);
  await shot(page, "slice-5-2-confirmed-wide.png");

  await page.reload();
  await expect(page.getByRole("article")).toContainText("Confirmed. The decision is saved in the audit log.");
  await expect(page.getByRole("article")).toContainText("Sari");
  await expect(page.locator("body")).not.toContainText(nik);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-5-2-confirmed-phone.png");
  await expectAudit();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("Message").fill("What does PP 58 say about withholding?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("summary:pp-58-2023")).toBeVisible();
  await expect(page.getByText("not the statute").first()).toBeVisible();
  await expect(page.getByText("The sources are short summaries.")).toBeVisible();
  await shot(page, "slice-5-3-citation-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-5-3-citation-phone.png");
  await page.reload();
  await expect(page.getByText("summary:pp-58-2023")).toBeVisible();
  await expect(page.getByRole("note")).toContainText("not official statute text");
});

async function resetAssistant(): Promise<void> {
  const client = await connect();
  try {
    await client.query("DELETE FROM ai_action_proposals");
    await client.query("DELETE FROM ai_messages");
    await client.query("DELETE FROM ai_conversations");
  } finally {
    await client.end();
  }
}

async function expectAudit(): Promise<void> {
  const client = await connect();
  try {
    const result = await client.query<{ diff: string }>(
      `SELECT diff_redacted_json::text AS diff
       FROM aud_events
       WHERE action = 'ai.proposal.executed'
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    const diff = result.rows[0]?.diff;
    if (!diff) throw new Error("audit row for the confirmed proposal is missing");
    expect(diff).toContain("executed");
    expect(diff).not.toContain(nik);
  } finally {
    await client.end();
  }
}

async function connect(): Promise<pg.Client> {
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

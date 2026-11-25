import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Signs in through Better Auth and saves one legal entity and one branch.
 * Run the API on port 3000 with BETTER_AUTH_URL set to the web origin, then:
 *   pnpm --filter @gotonghr/web test:e2e
 * Screenshots land in GOTONG_SCREENSHOT_DIR when that variable is set.
 */

const email = process.env.GOTONG_E2E_EMAIL ?? "owner@gotonghr.local";
const password = process.env.GOTONG_E2E_PASSWORD ?? "change-me-owner-password";
const shotDir = process.env.GOTONG_SCREENSHOT_DIR;

test("owner signs in, sees field errors, and keeps the company after reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await expect(page.getByRole("status")).toContainText("No legal entity yet.");
  await shot(page, "slice-1-4-empty-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-1-4-empty-phone.png");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("Company name").fill("PT Surya Nusantara");
  await page.getByLabel("NPWP (16 digits)").fill("123456789012345");
  await page.getByLabel("Branch name").fill("Jakarta Pusat");
  await page.getByLabel("NITKU (22 digits)").fill("123456789012345678901");
  await page.getByLabel("Timezone").selectOption("Asia/Jakarta");
  await page.getByLabel("UMP/UMK (rupiah)").fill("5.396.761");
  await page.getByRole("button", { name: "Save company setup" }).click();
  await expect(page.getByRole("alert")).toContainText("Check the highlighted fields.");
  await expect(page.getByText("NPWP must be 16 digits.")).toBeVisible();
  await expect(page.getByText("NITKU must be 22 digits.")).toBeVisible();
  await shot(page, "slice-1-4-error-wide.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-1-4-error-phone.png");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("NPWP (16 digits)").fill("0123456789012345");
  await page.getByLabel("NITKU (22 digits)").fill("0123456789012345678901");
  await page.getByLabel("Latitude").fill("-6.175392");
  await page.getByLabel("Longitude").fill("106.827153");
  await page.getByLabel("Radius (m)").fill("150");
  await page.getByRole("button", { name: "Save company setup" }).click();
  await expect(page.getByRole("status")).toContainText("Saved. PT Surya Nusantara · Jakarta Pusat.");
  await expect(page.getByRole("status")).toContainText("Rp5.396.761 per month.");
  await shot(page, "slice-1-4-saved-wide.png");

  await page.reload();
  await expect(page.getByLabel("Company name")).toHaveValue("PT Surya Nusantara");
  await expect(page.getByLabel("NPWP (16 digits)")).toHaveValue("0123456789012345");
  await expect(page.getByLabel("Branch name")).toHaveValue("Jakarta Pusat");
  await expect(page.getByLabel("NITKU (22 digits)")).toHaveValue("0123456789012345678901");
  await expect(page.getByRole("status")).toContainText("Saved.");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "slice-1-4-saved-phone.png");
});

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

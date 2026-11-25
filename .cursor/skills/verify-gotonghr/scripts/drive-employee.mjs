/**
 * Feature 03. Signs in, saves the company when the setup screen is empty,
 * adds Sari Wulandari through the form, reloads, and checks the mask.
 * Hidden fields are read from GET /api/v1/employees. The NIK ciphertext
 * is checked with SQL and is not copied into the evidence file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(pathToFileURL(path.resolve(repoRoot(), "apps/web/package.json")));
const { chromium } = require("@playwright/test");
const { Client } = require("pg");

const nik = "3273011508950001";
const mask = "3273********0001";
const code = "E001";
const name = "Sari Wulandari";

const baseUrl = required("BASE_URL");
const email = required("GOTONG_BOOTSTRAP_EMAIL");
const password = required("GOTONG_BOOTSTRAP_PASSWORD");
const evidence = required("EVIDENCE");
const databaseUrl = required("DATABASE_URL_SUPERUSER");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  baseURL: baseUrl,
  viewport: { width: 1440, height: 900 },
});
page.setDefaultTimeout(30_000);
page.setDefaultNavigationTimeout(60_000);

try {
  await page.goto("/sign-in");
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Set up the company" }).waitFor();

  const setupStatus = page.getByRole("status").first();
  await setupStatus.waitFor();
  const setupText = await setupStatus.innerText();
  if (setupText.includes("No legal entity yet.")) {
    await page.getByLabel("Company name").fill("PT Surya Nusantara");
    await page.getByLabel("NPWP (16 digits)").fill("0123456789012345");
    await page.getByLabel("Branch name").fill("Jakarta Pusat");
    await page.getByLabel("NITKU (22 digits)").fill("0123456789012345678901");
    await page.getByLabel("Timezone").selectOption("Asia/Jakarta");
    await page.getByLabel("UMP/UMK (rupiah)").fill("5.396.761");
    await page.getByLabel("Latitude").fill("-6.175392");
    await page.getByLabel("Longitude").fill("106.827153");
    await page.getByLabel("Radius (m)").fill("150");
    await page.getByRole("button", { name: "Save company setup" }).click();
    await textIncludes(page.getByRole("status").first(), "Saved. PT Surya Nusantara · Jakarta Pusat.");
  }

  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Employees" }).click();
  await page.getByRole("heading", { name: "Employees" }).waitFor();
  await page.getByRole("heading", { name: "Add employee" }).waitFor();
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Employee code").fill(code);
  await page.getByLabel("NIK").fill(nik);
  await page.getByRole("button", { name: "Add employee" }).click();
  await textIncludes(page.getByRole("status").first(), `Saved. ${name}.`);
  await page.getByText(mask).waitFor();
  if ((await page.getByText(nik).count()) !== 0) {
    throw new Error("The raw NIK was visible after save.");
  }

  await page.reload();
  await page.getByRole("heading", { name: "Employees" }).waitFor();
  await page.getByText(mask).waitFor();
  if ((await page.getByText(nik).count()) !== 0) {
    throw new Error("The raw NIK was visible after reload.");
  }
  const gotong = await page.getByText("GotongHR").count();
  if (gotong < 1) throw new Error("The reloaded page does not show GotongHR.");

  await mkdir(evidence, { recursive: true });
  const shot = path.join(evidence, "03-employee-reload.png");
  await page.screenshot({ path: shot, fullPage: true });
  const aria = await page.locator("body").ariaSnapshot();
  await writeFile(path.join(evidence, "03-employee-reload.aria.txt"), aria, "utf8");

  const listed = await page.evaluate(async () => {
    const response = await fetch("/api/v1/employees", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    return { status: response.status, body: await response.text() };
  });
  await writeFile(path.join(evidence, "03-employees.json"), listed.body, "utf8");
  if (listed.status !== 200) {
    throw new Error(`GET /api/v1/employees returned ${listed.status}.`);
  }
  const parsed = JSON.parse(listed.body);
  const row = Array.isArray(parsed.data)
    ? parsed.data.find((item) => item.employeeCode === code)
    : null;
  if (!row) throw new Error("The employee list has no E001 row.");
  if (row.fullName !== name) throw new Error("The list full name does not match.");
  if (row.nikMask !== mask) throw new Error(`nikMask is ${row.nikMask}.`);
  if (row.employmentStatus !== "active") throw new Error("employmentStatus is not active.");
  if (row.ptkpStatus !== "TK/0") throw new Error("ptkpStatus is not TK/0.");
  if (row.taxMethod !== "gross") throw new Error("taxMethod is not gross.");
  if (row.pph21SubjectType !== "permanent") throw new Error("pph21SubjectType is not permanent.");
  if (typeof row.joinDate !== "string" || row.joinDate.length === 0) {
    throw new Error("joinDate is missing from the list JSON.");
  }
  if (typeof row.legalEntityId !== "string" || typeof row.branchId !== "string") {
    throw new Error("The list JSON is missing the company ids.");
  }
  const packed = JSON.stringify(parsed);
  if (packed.includes(nik)) throw new Error("The list JSON contains the raw NIK.");
  if (packed.includes("nik_enc") || packed.includes("nikEnc")) {
    throw new Error("The list JSON contains ciphertext.");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sql = await client.query(
      `SELECT e.employee_code, e.full_name, p.nik_mask,
              (position($1 in p.nik_enc) > 0) AS enc_contains_plain
       FROM hr_employees AS e
       JOIN hr_employee_pii AS p ON p.employee_id = e.id AND p.tenant_id = e.tenant_id
       WHERE e.employee_code = $2`,
      [nik, code],
    );
    const stored = sql.rows[0];
    const lines = [
      `row_count=${sql.rowCount ?? 0}`,
      `employee_code=${stored?.employee_code ?? ""}`,
      `full_name=${stored?.full_name ?? ""}`,
      `nik_mask=${stored?.nik_mask ?? ""}`,
      `enc_contains_plain=${String(stored?.enc_contains_plain ?? "")}`,
    ];
    await writeFile(path.join(evidence, "03-employee-row.txt"), `${lines.join("\n")}\n`, "utf8");
    if ((sql.rowCount ?? 0) !== 1) throw new Error("Expected one employee row.");
    if (stored.full_name !== name || stored.nik_mask !== mask) {
      throw new Error("The stored name or mask does not match.");
    }
    if (stored.enc_contains_plain !== false) {
      throw new Error("nik_enc contains the raw NIK.");
    }
  } finally {
    await client.end();
  }

  process.stdout.write(`${JSON.stringify({ msg: "feature 03 passed", evidence })}\n`);
} catch (error) {
  await mkdir(evidence, { recursive: true }).catch(() => undefined);
  await page.screenshot({
    path: path.join(evidence, "03-employee-failure.png"),
    fullPage: true,
  }).catch(() => undefined);
  const message = error instanceof Error ? error.message : "drive failed";
  process.stderr.write(`${JSON.stringify({ msg: "feature 03 failed", error: message })}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function textIncludes(locator, expected) {
  try {
    await locator.filter({ hasText: expected }).waitFor();
  } catch {
    const text = await locator.innerText().catch(() => "");
    throw new Error(`Expected "${expected}" in "${text}".`);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function repoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
}

import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import type { TenantExportFile, TenantExportTable } from "@gotonghr/contracts";
import { readStoredZip, streamTenantExportZip } from "./zip-stream.ts";

test("ZIP CRC-32 matches the stored polynomial", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("the archive streams into storage and stays a readable ZIP", async () => {
  let written = 0;
  const parts: Buffer[] = [];
  const stored = await streamTenantExportZip({
    key: "tenant-exports/a/b.zip",
    tables: [
      table("employees", ["id", "employee_code", "full_name"], [
        ["emp-1", "EMP001", '=Sari, "A"'],
        ["emp-2", "EMP002", "Budi"],
      ]),
      table("contracts", ["id", "contract_type"], [["con-1", "PKWTT"]]),
      table("attendance", ["id", "punch_type"], [["clk-1", "clock_in"]]),
      table("leave", ["id", "status"], []),
      table("payroll_runs", ["id", "period_year_month"], [["run-1", "2026-03"]]),
    ],
    files: [
      storedFile("payslips/item.pdf", "%PDF-1.4\n", () => written),
      storedFile("coretax/one.xml", "<BPMP>ok</BPMP>", () => written),
    ],
    async putStream(input) {
      assert.equal(input.contentType, "application/zip");
      for await (const chunk of input.body) {
        written += chunk.byteLength;
        parts.push(Buffer.from(chunk));
      }
      return { byteSize: written };
    },
  });
  const bytes = Buffer.concat(parts);
  assert.equal(stored.byteSize, bytes.length);
  assert.equal(stored.byteSize, written);
  const entries = readStoredZip(bytes);
  assert.deepEqual(
    [...entries.keys()].sort(),
    [
      "attendance.csv",
      "contracts.csv",
      "coretax/one.xml",
      "employees.csv",
      "leave.csv",
      "payroll_runs.csv",
      "payslips/item.pdf",
    ],
  );
  const employees = entries.get("employees.csv")?.toString("utf8") ?? "";
  assert.equal(employees.startsWith("id,employee_code,full_name\n"), true);
  assert.equal(employees.includes(`"'=Sari, ""A"""`), true);
  assert.equal(employees.includes("EMP002"), true);
  assert.equal(entries.get("contracts.csv")?.toString("utf8").includes("PKWTT"), true);
  assert.equal(entries.get("attendance.csv")?.toString("utf8").includes("clock_in"), true);
  assert.equal(entries.get("leave.csv")?.toString("utf8"), "id,status\n");
  assert.equal(entries.get("payroll_runs.csv")?.toString("utf8").includes("2026-03"), true);
  assert.equal(entries.get("coretax/one.xml")?.toString("utf8"), "<BPMP>ok</BPMP>");
  assert.equal(entries.get("payslips/item.pdf")?.toString("utf8"), "%PDF-1.4\n");
});

test("a missing table fails before a file is opened", async () => {
  let opened = false;
  await assert.rejects(
    () =>
      streamTenantExportZip({
        key: "tenant-exports/a/c.zip",
        tables: [table("employees", ["id"], [])],
        files: [
          {
            zipPath: "coretax/one.xml",
            async open() {
              opened = true;
              return (async function* () {
                yield Buffer.from("<BPMP/>");
              })();
            },
          },
        ],
        async putStream(input) {
          for await (const chunk of input.body) void chunk.byteLength;
          return { byteSize: 1 };
        },
      }),
    /Export is missing/,
  );
  assert.equal(opened, false);
});

test("a path that leaves the archive is rejected", async () => {
  await assert.rejects(
    () =>
      streamTenantExportZip({
        key: "tenant-exports/a/d.zip",
        tables: [
          table("employees", ["id"], []),
          table("contracts", ["id"], []),
          table("attendance", ["id"], []),
          table("leave", ["id"], []),
          table("payroll_runs", ["id"], []),
        ],
        files: [storedFile("../secret.xml", "<BPMP/>", () => 1)],
        async putStream(input) {
          for await (const chunk of input.body) void chunk.byteLength;
          return { byteSize: 1 };
        },
      }),
    /not allowed/,
  );
});

function table(
  name: TenantExportTable["name"],
  columns: readonly string[],
  records: Array<Array<string | null>>,
): TenantExportTable {
  return {
    name,
    columns,
    async *rows() {
      for (const record of records) yield record;
    },
  };
}

function storedFile(zipPath: string, text: string, written: () => number): TenantExportFile {
  return {
    zipPath,
    async open() {
      assert.ok(written() > 0, "CSV bytes were accepted before the stored file opened");
      return (async function* () {
        yield Buffer.from(text);
      })();
    },
  };
}

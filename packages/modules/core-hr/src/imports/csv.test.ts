import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { csvRecords } from "./csv.ts";
import { BAD_NIK_LINES, badNikCsv, validEmployeeCsv } from "./fixtures.ts";

describe("csv stream", () => {
  it("parses records that are split across chunks, including a quoted newline", async () => {
    const file = 'employee_code,full_name\nE1,"Sari, Putri\nWulandari"\nE2,Budi\n';
    const chunks: string[] = [];
    for (let index = 0; index < file.length; index += 3) chunks.push(file.slice(index, index + 3));
    const records = [];
    for await (const record of csvRecords(streamOf(chunks))) records.push(record);
    assert.equal(records.length, 3);
    assert.deepEqual(records[1]?.fields, ["E1", "Sari, Putri\nWulandari"]);
    assert.equal(records[1]?.line, 2);
    assert.deepEqual(records[2]?.fields, ["E2", "Budi"]);
  });

  it("keeps an escaped quote when the chunk boundary falls on it", async () => {
    const file = '"a""b",ok\n';
    const records = [];
    for await (const record of csvRecords(streamOf(['"a"', '"b",ok\n']))) records.push(record);
    assert.deepEqual(records[0]?.fields, ['a"b', "ok"]);
    assert.equal(file.includes('""'), true);
  });

  it("builds a 500-row fixture and marks the three bad NIK lines", () => {
    const valid = validEmployeeCsv(500).trimEnd().split("\n");
    assert.equal(valid.length, 501);
    assert.equal(valid[1]?.split(",")[2], "3273011508950001");
    assert.equal(valid[500]?.split(",")[2], "3273011508950500");
    const bad = badNikCsv().trimEnd().split("\n");
    for (const line of BAD_NIK_LINES) {
      assert.equal(bad[line - 1]?.split(",")[2], "3273013208950001");
    }
  });

  it("does not read the import file with readFile", () => {
    const source = readFileSync(new URL("./process.ts", import.meta.url), "utf8");
    assert.equal(source.includes("readFile"), false);
    assert.equal(source.includes("openRead"), true);
  });
});

async function* streamOf(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { extractPdfText, PdfTextError } from "./pdf-text.ts";

test("extractPdfText reads a plain text stream and a compressed stream", () => {
  const plain = pdfStream(Buffer.from("BT (Night shift SOP) Tj ET"), false);
  assert.equal(extractPdfText(plain), "Night shift SOP");
  const compressed = pdfStream(deflateSync(Buffer.from("BT (Overtime handover) Tj ET")), true);
  assert.equal(extractPdfText(compressed), "Overtime handover");
});

test("extractPdfText rejects a file that is not a text PDF", () => {
  assert.throws(() => extractPdfText(Buffer.from("hello")), (error: unknown) => {
    return error instanceof PdfTextError && error.reason === "not_pdf";
  });
  const empty = pdfStream(Buffer.from("BT ET"), false);
  assert.throws(() => extractPdfText(empty), (error: unknown) => {
    return error instanceof PdfTextError && error.reason === "no_text";
  });
});

function pdfStream(stream: Buffer, flate: boolean): Buffer {
  const filter = flate ? " /Filter /FlateDecode" : "";
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n"),
    Buffer.from(`<< /Length ${stream.length}${filter} >>\nstream\n`),
    stream,
    Buffer.from("\nendstream\nendobj\n%%EOF\n"),
  ]);
}

import { inflateSync } from "node:zlib";

const MAX_PDF_BYTES = 1_000_000;
const MAX_INFLATED = 1_000_000;

export class PdfTextError extends Error {
  readonly reason: "empty" | "too_large" | "not_pdf" | "no_text";

  constructor(reason: "empty" | "too_large" | "not_pdf" | "no_text") {
    super(reason);
    this.name = "PdfTextError";
    this.reason = reason;
  }
}

/**
 * Reads text operators from a small text PDF. It does not render pages,
 * run JavaScript, or open images. Scanned pages return no text.
 */
export function extractPdfText(input: Uint8Array): string {
  if (input.byteLength === 0) throw new PdfTextError("empty");
  if (input.byteLength > MAX_PDF_BYTES) throw new PdfTextError("too_large");
  const bytes = Buffer.from(input);
  if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) throw new PdfTextError("not_pdf");
  const pieces: string[] = [];
  for (const stream of readStreams(bytes)) {
    const data = stream.flate ? inflateBounded(stream.data) : stream.data;
    if (!data) continue;
    const text = showStrings(data.toString("latin1"));
    if (text.length > 0) pieces.push(text);
  }
  const joined = pieces.join("\n").replace(/[ \t]{2,}/g, " ").trim();
  if (joined.length === 0) throw new PdfTextError("no_text");
  return joined;
}

function readStreams(bytes: Buffer): Array<{ data: Buffer; flate: boolean }> {
  const raw = bytes.toString("latin1");
  const found: Array<{ data: Buffer; flate: boolean }> = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf("stream", cursor);
    if (start < 0) break;
    const prefix = raw.slice(Math.max(0, start - 3), start);
    if (prefix.endsWith("end") || /[A-Za-z]/u.test(raw[start - 1] ?? "")) {
      cursor = start + 6;
      continue;
    }
    let dataStart = start + "stream".length;
    if (raw.charCodeAt(dataStart) === 13) dataStart += 1;
    if (raw.charCodeAt(dataStart) === 10) dataStart += 1;
    const dict = raw.slice(Math.max(0, start - 500), start);
    const length = directLength(dict);
    let dataEnd: number;
    if (length !== null && dataStart + length <= raw.length) {
      dataEnd = dataStart + length;
    } else {
      const end = raw.indexOf("endstream", dataStart);
      if (end < 0) break;
      dataEnd = end;
      if (raw.charCodeAt(dataEnd - 1) === 10) dataEnd -= 1;
      if (raw.charCodeAt(dataEnd - 1) === 13) dataEnd -= 1;
    }
    found.push({
      data: Buffer.from(raw.slice(dataStart, dataEnd), "latin1"),
      flate: /\/FlateDecode\b/u.test(dict),
    });
    cursor = Math.max(dataEnd + 1, start + 6);
  }
  return found;
}

function directLength(dict: string): number | null {
  const matches = [...dict.matchAll(/\/Length\s+(\d+)(?!\s+0\s+R)/gu)];
  const last = matches[matches.length - 1];
  if (!last?.[1]) return null;
  const length = Number(last[1]);
  if (!Number.isInteger(length) || length < 0) return null;
  return length;
}

function inflateBounded(data: Buffer): Buffer | null {
  try {
    const inflated = inflateSync(data, { maxOutputLength: MAX_INFLATED });
    if (inflated.length > MAX_INFLATED) return null;
    return inflated;
  } catch {
    return null;
  }
}

function showStrings(content: string): string {
  const parts: string[] = [];
  let pending: string[] = [];
  let index = 0;
  while (index < content.length) {
    const current = content[index];
    if (current === "(") {
      const parsed = parseLiteral(content, index);
      if (!parsed) break;
      pending.push(parsed.value);
      index = parsed.end;
      continue;
    }
    if (current === "<" && content[index + 1] !== "<") {
      const parsed = parseHex(content, index);
      if (!parsed) {
        index += 1;
        continue;
      }
      pending.push(parsed.value);
      index = parsed.end;
      continue;
    }
    if (tokenAt(content, index, "Tj") || tokenAt(content, index, "'")) {
      if (pending.length > 0) parts.push(pending.join(""));
      pending = [];
      index += current === "'" ? 1 : 2;
      continue;
    }
    if (tokenAt(content, index, "TJ")) {
      if (pending.length > 0) parts.push(pending.join(""));
      pending = [];
      index += 2;
      continue;
    }
    index += 1;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function tokenAt(content: string, index: number, token: string): boolean {
  if (!content.startsWith(token, index)) return false;
  const before = content[index - 1] ?? "";
  const after = content[index + token.length] ?? "";
  if (/[A-Za-z]/u.test(before) || /[A-Za-z]/u.test(after)) return false;
  return true;
}

function parseLiteral(text: string, start: number): { value: string; end: number } | null {
  let index = start + 1;
  let depth = 1;
  let out = "";
  while (index < text.length) {
    const current = text[index];
    if (current === "\\") {
      const next = text[index + 1];
      if (next === undefined) return null;
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "b") out += "\b";
      else if (next === "f") out += "\f";
      else if (next === "\n") out += "";
      else if (next === "\r") {
        index += text[index + 2] === "\n" ? 3 : 2;
        continue;
      } else {
        const octal = /^[0-7]{1,3}/u.exec(text.slice(index + 1));
        if (octal && next !== "(" && next !== ")" && next !== "\\") {
          out += String.fromCharCode(Number.parseInt(octal[0], 8));
          index += 1 + octal[0].length;
          continue;
        }
        out += next;
      }
      index += 2;
      continue;
    }
    if (current === "(") {
      depth += 1;
      out += current;
      index += 1;
      continue;
    }
    if (current === ")") {
      depth -= 1;
      if (depth === 0) return { value: out, end: index + 1 };
      out += current;
      index += 1;
      continue;
    }
    out += current;
    index += 1;
  }
  return null;
}

function parseHex(text: string, start: number): { value: string; end: number } | null {
  const end = text.indexOf(">", start + 1);
  if (end < 0) return null;
  const hex = text.slice(start + 1, end).replace(/\s+/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/u.test(hex)) return null;
  let out = "";
  for (let index = 0; index < hex.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return { value: out, end: end + 1 };
}

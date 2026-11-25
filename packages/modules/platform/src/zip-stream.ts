import { crc32 as zlibCrc32 } from "node:zlib";
import {
  tenantExportTableNames,
  type TenantExportFile,
  type TenantExportTable,
} from "@gotonghr/contracts";

const ZIP_TIME = 0;
const ZIP_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const zipName = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/;

interface ZipEntry {
  name: string;
  body: AsyncIterable<Uint8Array>;
}

interface CentralEntry {
  name: string;
  crc: number;
  size: number;
  offset: number;
}

export interface TenantExportUpload {
  key: string;
  body: AsyncIterable<Uint8Array>;
  contentType: string;
}

/**
 * STORE-method ZIP. Each entry is yielded as it is read.
 * The caller pipes this generator into storage and does not buffer the archive.
 */
export async function streamTenantExportZip(input: {
  key: string;
  tables: readonly TenantExportTable[];
  files: readonly TenantExportFile[];
  putStream(upload: TenantExportUpload): Promise<{ byteSize: number }>;
}): Promise<{ byteSize: number }> {
  const stored = await input.putStream({
    key: input.key,
    contentType: "application/zip",
    body: zipStore(exportEntries(input.tables, input.files)),
  });
  if (!Number.isSafeInteger(stored.byteSize) || stored.byteSize < 1) {
    throw new Error("Export archive is empty.");
  }
  return stored;
}

export async function* zipStore(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const central: CentralEntry[] = [];
  let offset = 0;
  for await (const entry of entries) {
    assertZipName(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    if (name.length > 200) throw new Error("ZIP entry name is too long.");
    const local = localHeader(name);
    yield local;
    let crc = 0;
    let size = 0;
    for await (const chunk of entry.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.byteLength === 0) continue;
      crc = zlibCrc32(bytes, crc);
      size += bytes.byteLength;
      if (size > 0xffffffff) throw new Error("ZIP entry is larger than 4 GB.");
      yield bytes;
    }
    const descriptor = dataDescriptor(crc >>> 0, size);
    yield descriptor;
    central.push({ name: entry.name, crc: crc >>> 0, size, offset });
    offset += local.length + size + descriptor.length;
    if (offset > 0xffffffff) throw new Error("ZIP is larger than 4 GB.");
  }
  if (central.length > 0xffff) throw new Error("ZIP has too many entries.");
  const directoryStart = offset;
  let directorySize = 0;
  for (const item of central) {
    const header = centralHeader(item);
    directorySize += header.length;
    offset += header.length;
    yield header;
  }
  yield endOfDirectory(central.length, directorySize, directoryStart);
}

/** Reads a STORE ZIP produced by zipStore. The central directory is the source of names and sizes. */
export function readStoredZip(input: Uint8Array): Map<string, Buffer> {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 22) throw new Error("ZIP is too small.");
  const eocd = bytes.length - 22;
  if (bytes.readUInt32LE(eocd) !== 0x06054b50) throw new Error("ZIP directory is missing.");
  if (bytes.readUInt16LE(eocd + 20) !== 0) throw new Error("ZIP comment is not supported.");
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("ZIP spans disks.");
  }
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryStart = bytes.readUInt32LE(eocd + 16);
  if (directoryStart + directorySize !== eocd) throw new Error("ZIP directory size does not match.");
  const files = new Map<string, Buffer>();
  let cursor = directoryStart;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP central header is missing.");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (method !== 0) throw new Error(`ZIP entry ${name} is compressed.`);
    if ((flags & 0x0008) === 0) throw new Error(`ZIP entry ${name} has no data descriptor.`);
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header is missing for ${name}.`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtra = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localName !== name) throw new Error(`ZIP name mismatch for ${name}.`);
    const dataStart = localOffset + 30 + localNameLength + localExtra;
    const data = bytes.subarray(dataStart, dataStart + size);
    if ((zlibCrc32(data) >>> 0) !== crc) throw new Error(`ZIP checksum mismatch for ${name}.`);
    const descriptor = dataStart + size;
    if (bytes.readUInt32LE(descriptor) !== 0x08074b50) throw new Error(`ZIP descriptor is missing for ${name}.`);
    if (bytes.readUInt32LE(descriptor + 4) !== crc || bytes.readUInt32LE(descriptor + 8) !== size) {
      throw new Error(`ZIP descriptor mismatch for ${name}.`);
    }
    files.set(name, Buffer.from(data));
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== eocd) throw new Error("ZIP directory did not end where expected.");
  return files;
}

async function* exportEntries(
  tables: readonly TenantExportTable[],
  files: readonly TenantExportFile[],
): AsyncGenerator<ZipEntry> {
  const byName = new Map(tables.map((table) => [table.name, table]));
  for (const name of tenantExportTableNames) {
    if (!byName.has(name)) throw new Error(`Export is missing ${name}.`);
  }
  if (tables.length !== tenantExportTableNames.length) throw new Error("Export table set is wrong.");
  for (const name of tenantExportTableNames) {
    const table = byName.get(name);
    if (!table) throw new Error(`Export is missing ${name}.`);
    const entryName = `${name}.csv`;
    assertZipName(entryName);
    yield { name: entryName, body: csvBody(table) };
  }
  const seen = new Set<string>();
  const sorted = [...files].sort((left, right) => {
    if (left.zipPath < right.zipPath) return -1;
    if (left.zipPath > right.zipPath) return 1;
    return 0;
  });
  for (const file of sorted) {
    assertZipName(file.zipPath);
    if (seen.has(file.zipPath)) throw new Error("Export file path is duplicated.");
    seen.add(file.zipPath);
    const opened = await file.open();
    yield { name: file.zipPath, body: bytesOf(opened) };
  }
}

async function* csvBody(table: TenantExportTable): AsyncGenerator<Uint8Array> {
  yield Buffer.from(`${table.columns.map((column) => csvCell(column)).join(",")}\n`);
  for await (const row of table.rows()) {
    if (row.length !== table.columns.length) throw new Error("Export row width does not match.");
    yield Buffer.from(`${row.map((value) => csvCell(value ?? "")).join(",")}\n`);
  }
}

async function* bytesOf(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  }
}

function csvCell(value: string): string {
  const guarded =
    value.startsWith("=") || value.startsWith("+") || value.startsWith("-") || value.startsWith("@")
      ? `'${value}`
      : value;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replaceAll('"', '""')}"`;
  return guarded;
}

function assertZipName(name: string): void {
  if (!zipName.test(name) || name.includes("..") || name.includes("//") || name.endsWith("/")) {
    throw new Error("ZIP entry name is not allowed.");
  }
}

function localHeader(name: Buffer): Buffer {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(ZIP_TIME, 10);
  header.writeUInt16LE(ZIP_DATE, 12);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function dataDescriptor(crc: number, size: number): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x08074b50, 0);
  header.writeUInt32LE(crc, 4);
  header.writeUInt32LE(size, 8);
  header.writeUInt32LE(size, 12);
  return header;
}

function centralHeader(item: CentralEntry): Buffer {
  const name = Buffer.from(item.name, "utf8");
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(ZIP_TIME, 12);
  header.writeUInt16LE(ZIP_DATE, 14);
  header.writeUInt32LE(item.crc, 16);
  header.writeUInt32LE(item.size, 20);
  header.writeUInt32LE(item.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(item.offset, 42);
  name.copy(header, 46);
  return header;
}

function endOfDirectory(count: number, size: number, offset: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(count, 8);
  header.writeUInt16LE(count, 10);
  header.writeUInt32LE(size, 12);
  header.writeUInt32LE(offset, 16);
  return header;
}

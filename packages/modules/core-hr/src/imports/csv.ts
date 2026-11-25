import { StringDecoder } from "node:string_decoder";

const MAX_RECORD_CHARS = 64 * 1024;

export interface CsvRecord {
  /** 1-based line where the record starts. A quoted newline stays on that line number. */
  line: number;
  fields: string[];
}

export class CsvFormatError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(message);
    this.name = "CsvFormatError";
    this.line = line;
  }
}

interface ParseState {
  line: number;
  startLine: number;
  field: string;
  fields: string[];
  inQuotes: boolean;
  pendingQuote: boolean;
  size: number;
  started: boolean;
}

/**
 * Yields one CSV record at a time. The only buffered text is the current record,
 * which is capped, so the caller never holds the whole file in one string.
 */
export async function* csvRecords(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<CsvRecord> {
  const decoder = new StringDecoder("utf8");
  const state: ParseState = {
    line: 1,
    startLine: 1,
    field: "",
    fields: [],
    inQuotes: false,
    pendingQuote: false,
    size: 0,
    started: false,
  };
  for await (const chunk of source) {
    yield* consume(decodeChunk(decoder, chunk), state);
  }
  const rest = decoder.end();
  if (rest.length > 0) yield* consume(rest, state);
  if (state.pendingQuote) {
    state.pendingQuote = false;
    state.inQuotes = false;
  }
  if (state.inQuotes) {
    throw new CsvFormatError(state.startLine, "A quoted field was not closed.");
  }
  if (state.started || state.field.length > 0 || state.fields.length > 0) {
    state.fields.push(state.field);
    yield { line: state.startLine, fields: state.fields };
  }
}

function decodeChunk(decoder: StringDecoder, chunk: Uint8Array | string): string {
  if (typeof chunk === "string") return chunk;
  return decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

function* consume(text: string, state: ParseState): Generator<CsvRecord> {
  let index = 0;
  if (state.pendingQuote) {
    state.pendingQuote = false;
    if (text.startsWith('"')) {
      push(state, '"');
      index = 1;
    } else {
      state.inQuotes = false;
    }
  }
  while (index < text.length) {
    const char = text[index] ?? "";
    if (state.inQuotes) {
      if (char === '"') {
        const next = text[index + 1];
        if (next === undefined) {
          state.pendingQuote = true;
          index += 1;
          continue;
        }
        if (next === '"') {
          push(state, '"');
          index += 2;
          continue;
        }
        state.inQuotes = false;
        index += 1;
        continue;
      }
      if (char === "\n") state.line += 1;
      push(state, char);
      index += 1;
      continue;
    }
    if (char === '"') {
      state.inQuotes = true;
      state.started = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      state.fields.push(state.field);
      state.field = "";
      state.started = true;
      index += 1;
      continue;
    }
    if (char === "\n") {
      state.line += 1;
      if (state.started || state.field.length > 0 || state.fields.length > 0) {
        state.fields.push(state.field);
        const record = { line: state.startLine, fields: state.fields };
        state.fields = [];
        state.field = "";
        state.size = 0;
        state.started = false;
        state.startLine = state.line;
        yield record;
      } else {
        state.startLine = state.line;
      }
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    push(state, char);
    state.started = true;
    index += 1;
  }
}

function push(state: ParseState, char: string): void {
  state.size += char.length;
  if (state.size > MAX_RECORD_CHARS) {
    throw new CsvFormatError(state.startLine, "A CSV row is too long.");
  }
  state.field += char;
}

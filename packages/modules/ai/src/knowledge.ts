import type { TenantDatabase } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import type { AiCaller } from "./caller.ts";
import { chunkText } from "./chunk.ts";
import { extractPdfText, PdfTextError } from "./pdf-text.ts";
import { readSearchDriver } from "./search-driver.ts";
import { rowsOf } from "./store.ts";
import { callerMaySearchPolicy, parsePolicyQuery, type ToolDispatch } from "./tools.ts";

const MAX_PDF_BASE64 = 1_400_000;
const STOP = new Set([
  "a",
  "an",
  "about",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "our",
  "please",
  "say",
  "tell",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "with",
  "you",
]);

export interface SopIngestInput {
  title: string;
  text?: string;
  pdfBase64?: string;
}

export interface SopDocument {
  documentId: string;
  title: string;
  citationRef: string;
  chunkCount: number;
  createdAt: string;
}

export interface SopCreated {
  documentId: string;
  title: string;
  citationRef: string;
  chunkCount: number;
}

type KnowledgeFailure = {
  ok: false;
  status: 400 | 403 | 404;
  code: string;
  message: string;
};

interface ChunkRow {
  citation_ref: string;
  title: string;
  content: string;
  is_statute_text: boolean | string;
  source_type: string;
}

/** Turns a question into a safe OR tsquery. Tokens are letters and digits only. */
export function keywordQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^0-9a-z]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP.has(token));
  const unique = [...new Set(tokens)].slice(0, 8);
  if (unique.length === 0) return null;
  return unique.join(" | ");
}

export async function runPolicySearch(
  database: TenantDatabase,
  caller: AiCaller,
  args: unknown,
): Promise<ToolDispatch> {
  if (!callerMaySearchPolicy(caller)) return { ok: false, code: "forbidden" };
  const query = parsePolicyQuery(args);
  if (!query) return { ok: false, code: "invalid" };
  if (readSearchDriver(process.env) !== "keyword") return { ok: false, code: "search_unavailable" };
  const tsquery = keywordQuery(query);
  const matches = tsquery === null ? [] : await searchChunks(database, caller.tenantId, tsquery);
  return {
    ok: true,
    mutating: false,
    result: {
      query,
      corpus_incomplete: true,
      matches: matches.map((match) => ({
        citation_ref: match.citationRef,
        title: match.title,
        content: match.content,
        not_the_statute: match.notTheStatute,
        source_type: match.sourceType,
      })),
    },
  };
}

export async function ingestTenantSop(
  database: TenantDatabase,
  caller: AiCaller,
  input: SopIngestInput,
): Promise<{ ok: true; data: SopCreated } | KnowledgeFailure> {
  if (!caller.permissions.includes("ai.knowledge.write")) {
    return failure(403, "forbidden", "Missing permission.");
  }
  const parsed = parseIngest(input);
  if (!parsed.ok) return parsed;
  const chunks = chunkText(parsed.text);
  if (chunks === null) return failure(400, "invalid_body", "The document is too long.");
  if (chunks.length === 0) return failure(400, "invalid_body", "The document has no text.");
  return database.withTenantContext(caller.tenantId, async (tx) => {
    const ids = rowsOf<{ id: string }>(await tx.execute(sql`SELECT uuidv7()::text AS id`));
    const documentId = ids[0]?.id;
    if (!documentId) throw new Error("uuidv7 returned no id");
    const citationRef = `sop:${documentId}`;
    for (const [index, content] of chunks.entries()) {
      await tx.execute(sql`
        INSERT INTO ai_knowledge_chunks (
          tenant_id, source_type, citation_ref, title, content, is_statute_text, document_id, chunk_index
        ) VALUES (
          ${caller.tenantId}::uuid,
          'tenant_sop',
          ${citationRef},
          ${parsed.title},
          ${content},
          false,
          ${documentId}::uuid,
          ${index}
        )
      `);
    }
    return {
      ok: true as const,
      data: { documentId, title: parsed.title, citationRef, chunkCount: chunks.length },
    };
  });
}

export async function listTenantSops(
  database: TenantDatabase,
  caller: AiCaller,
): Promise<{ ok: true; data: { documents: SopDocument[] } } | KnowledgeFailure> {
  if (!caller.permissions.includes("ai.knowledge.read")) {
    return failure(403, "forbidden", "Missing permission.");
  }
  return database.withTenantContext(caller.tenantId, async (tx) => {
    const rows = rowsOf<{
      document_id: string;
      title: string;
      citation_ref: string;
      chunk_count: number | string;
      created_at: Date | string;
    }>(await tx.execute(sql`
      SELECT
        document_id::text AS document_id,
        min(title) AS title,
        min(citation_ref) AS citation_ref,
        count(*)::int AS chunk_count,
        min(created_at) AS created_at
      FROM ai_knowledge_chunks
      WHERE source_type = 'tenant_sop'
      GROUP BY document_id
      ORDER BY min(created_at) DESC, document_id
    `));
    return {
      ok: true as const,
      data: {
        documents: rows.map((row) => ({
          documentId: row.document_id,
          title: row.title,
          citationRef: row.citation_ref,
          chunkCount: Number(row.chunk_count),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        })),
      },
    };
  });
}

export async function deleteTenantSop(
  database: TenantDatabase,
  caller: AiCaller,
  documentId: string,
): Promise<{ ok: true; data: { documentId: string; deletedChunks: number } } | KnowledgeFailure> {
  if (!caller.permissions.includes("ai.knowledge.write")) {
    return failure(403, "forbidden", "Missing permission.");
  }
  return database.withTenantContext(caller.tenantId, async (tx) => {
    const rows = rowsOf<{ id: string }>(await tx.execute(sql`
      DELETE FROM ai_knowledge_chunks
      WHERE document_id = ${documentId}::uuid
        AND source_type = 'tenant_sop'
      RETURNING id::text AS id
    `));
    if (rows.length === 0) return failure(404, "not_found", "SOP not found.");
    return { ok: true as const, data: { documentId, deletedChunks: rows.length } };
  });
}

async function searchChunks(
  database: TenantDatabase,
  tenantId: string,
  tsquery: string,
): Promise<
  Array<{
    citationRef: string;
    title: string;
    content: string;
    notTheStatute: boolean;
    sourceType: "tenant_sop" | "curated_summary";
  }>
> {
  return database.withTenantContext(tenantId, async (tx) => {
    const rows = rowsOf<ChunkRow>(await tx.execute(sql`
      SELECT citation_ref, title, content, is_statute_text, source_type
      FROM ai_knowledge_chunks
      WHERE search_vector @@ to_tsquery('simple', ${tsquery})
      ORDER BY ts_rank_cd(search_vector, to_tsquery('simple', ${tsquery})) DESC, chunk_index ASC
      LIMIT 4
    `));
    const matches: Array<{
      citationRef: string;
      title: string;
      content: string;
      notTheStatute: boolean;
      sourceType: "tenant_sop" | "curated_summary";
    }> = [];
    for (const row of rows) {
      const sourceType = row.source_type === "tenant_sop" || row.source_type === "curated_summary" ? row.source_type : null;
      if (sourceType === null) continue;
      const statute = row.is_statute_text === true || row.is_statute_text === "t" || row.is_statute_text === "true";
      matches.push({
        citationRef: row.citation_ref,
        title: row.title,
        content: row.content,
        notTheStatute: !statute,
        sourceType,
      });
    }
    return matches;
  });
}

function parseIngest(
  input: SopIngestInput,
): { ok: true; title: string; text: string } | KnowledgeFailure {
  const title = input.title.trim();
  if (title.length === 0 || title.length > 120) {
    return failure(400, "invalid_body", "Title is required.");
  }
  const hasText = typeof input.text === "string";
  const hasPdf = typeof input.pdfBase64 === "string";
  if (hasText === hasPdf) return failure(400, "invalid_body", "Send plain text or a PDF.");
  if (hasText && input.text !== undefined) {
    const text = input.text.split("\u0000").join("").trim();
    if (text.length === 0) return failure(400, "invalid_body", "The document has no text.");
    return { ok: true, title, text };
  }
  if (!input.pdfBase64) return failure(400, "invalid_body", "Send plain text or a PDF.");
  const compact = input.pdfBase64.replace(/\s/g, "");
  if (compact.length === 0 || compact.length > MAX_PDF_BASE64 || !/^[A-Za-z0-9+/=]+$/u.test(compact)) {
    return failure(400, "invalid_body", "The PDF could not be read as text.");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0 || bytes.length > 1_000_000) {
    return failure(400, "invalid_body", "The PDF could not be read as text.");
  }
  try {
    return { ok: true, title, text: extractPdfText(bytes) };
  } catch (error) {
    if (error instanceof PdfTextError) {
      return failure(400, "invalid_body", "The PDF could not be read as text.");
    }
    throw error;
  }
}

function failure(status: KnowledgeFailure["status"], code: string, message: string): KnowledgeFailure {
  return { ok: false, status, code, message };
}

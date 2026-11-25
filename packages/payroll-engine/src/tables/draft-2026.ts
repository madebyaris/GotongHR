import raw from "./id-2026.draft.json" with { type: "json" };
import { parseStatutoryTable } from "./parse.ts";
import type { StatutoryTable } from "./types.ts";

/** The shipped 2026 draft. TER rates, PTKP rupiah, and the JP cap are missing on purpose. */
export const id2026DraftTable: StatutoryTable = parseStatutoryTable(raw);

import raw from "./id-2026.draft.json" with { type: "json" };
import { parseStatutoryTable } from "./parse.ts";
import type { StatutoryTable } from "./types.ts";

/**
 * The shipped 2026 draft, for inspection only.
 * It is not on the package's default export. TER rates, PTKP rupiah, and the JP cap are missing.
 * calculateMonthlyPph21, reconcilePph21, findTableForDate, and biayaJabatan refuse it unless allowUndeclared is set.
 */
export const id2026DraftTable: StatutoryTable = parseStatutoryTable(raw);

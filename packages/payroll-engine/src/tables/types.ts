import type { PtkpStatus } from "@gotonghr/contracts";

export const terCategories = ["A", "B", "C"] as const;

export type TerCategory = (typeof terCategories)[number];

export type TableStatus = "draft" | "published";

export interface Pasal17Band {
  readonly upTo: bigint | null;
  readonly ratePerScale: bigint;
  readonly rateScale: bigint;
}

export interface TerBracket {
  readonly upTo: bigint | null;
  readonly ratePerScale: bigint;
}

export type SourcedAmount =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly source: string; readonly rupiah: bigint };

export type TerCategoryTable =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly source: string; readonly brackets: readonly TerBracket[] };

/**
 * Effective-dated PPh 21 rules.
 * Money fields are bigint rupiah. A missing amount or TER category has no numeric stand-in.
 */
export interface StatutoryTable {
  readonly schemaVersion: 1;
  readonly ruleType: "pph21";
  readonly status: TableStatus;
  readonly fixture: "synthetic" | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly pasal17: {
    readonly source: string;
    readonly pkpRoundDownTo: bigint;
    readonly bands: readonly Pasal17Band[];
  };
  readonly biayaJabatan: {
    readonly source: string;
    readonly ratePerScale: bigint;
    readonly rateScale: bigint;
    readonly rounding: "floor";
    readonly monthlyCap: bigint;
  };
  readonly ptkpAnnual: {
    readonly source: string;
    readonly amounts: Readonly<Record<PtkpStatus, SourcedAmount>>;
  };
  readonly ter: {
    readonly source: string;
    readonly taxRounding: "half_up";
    readonly rateScale: bigint;
    readonly categories: Readonly<Record<TerCategory, TerCategoryTable>>;
  };
  readonly jpAnnualWageCap: SourcedAmount;
}

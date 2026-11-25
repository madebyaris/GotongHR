export const piiFields = [
  "nik",
  "npwp",
  "kk_number",
  "bpjs_kesehatan_no",
  "bpjs_tk_no",
  "bank_account_number",
] as const;

export type PiiField = (typeof piiFields)[number];

const piiFieldSet: ReadonlySet<string> = new Set(piiFields);

export function isPiiField(value: string): value is PiiField {
  return piiFieldSet.has(value);
}

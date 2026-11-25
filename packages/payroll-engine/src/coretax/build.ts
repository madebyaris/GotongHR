import { CoretaxPreflightError, CoretaxWithholderError } from "./errors.ts";
import { failedIndexes, preflightCoretaxRecords } from "./preflight.ts";
import type { CoretaxBatchResult, CoretaxRecord, CoretaxSlipType, CoretaxWithholder } from "./types.ts";
import { renderCoretaxXml } from "./xml.ts";

/**
 * Builds one bulk file for a single employee.
 * Throws CoretaxWithholderError when the NPWP or NITKU cannot head a file.
 * Throws CoretaxPreflightError when the record fails. The return value is XML, never a slip for a failed record.
 */
export function buildCoretaxSlip(withholder: CoretaxWithholder, record: CoretaxRecord): string {
  const preflight = preflightCoretaxRecords([record], withholder);
  if (preflight.withholderIssues.length > 0) throw new CoretaxWithholderError(preflight.withholderIssues);
  if (preflight.issues.length > 0) throw new CoretaxPreflightError(preflight.issues);
  return renderCoretaxXml(record.slipType, withholder, [record]);
}

/**
 * Builds one bulk file and a preflight report.
 * Records that fail preflight are left out of the XML. Their issues stay on the report.
 * A bad withholder throws, because the file would have no valid TIN.
 */
export function buildCoretaxBatch(input: {
  readonly slipType: CoretaxSlipType;
  readonly withholder: CoretaxWithholder;
  readonly records: readonly CoretaxRecord[];
}): CoretaxBatchResult {
  const preflight = preflightCoretaxRecords(input.records, input.withholder, input.slipType);
  if (preflight.withholderIssues.length > 0) throw new CoretaxWithholderError(preflight.withholderIssues);
  const failed = failedIndexes(preflight);
  const accepted = input.records.filter((_, index) => !failed.has(index));
  return {
    slipType: input.slipType,
    xml: renderCoretaxXml(input.slipType, input.withholder, accepted),
    preflight,
  };
}

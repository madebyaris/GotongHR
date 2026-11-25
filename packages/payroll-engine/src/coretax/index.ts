export { buildCoretaxBatch, buildCoretaxSlip } from "./build.ts";
export { CoretaxPreflightError, CoretaxWithholderError } from "./errors.ts";
export { preflightCoretaxRecords } from "./preflight.ts";
export { escapeXml, formatScaledPercent } from "./text.ts";
export { coretaxSlipTypes } from "./types.ts";
export type {
  Bpa1Amounts,
  Bpa1Record,
  Bp21Record,
  Bp26Record,
  BpmpRecord,
  CoretaxBatchResult,
  CoretaxFieldIssue,
  CoretaxPreflightIssue,
  CoretaxPreflightReport,
  CoretaxRecord,
  CoretaxSlipType,
  CoretaxWithholder,
  CounterpartOpt,
  ScaledRate,
} from "./types.ts";
export { coretaxXsdDirectory, findCoretaxXsdFiles, validateCoretaxXml } from "./xsd.ts";
export type { XsdValidation } from "./xsd.ts";

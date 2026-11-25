import type { CoretaxFieldIssue, CoretaxPreflightIssue } from "./types.ts";

/** Thrown by buildCoretaxSlip when that one record fails preflight. The batch builder does not throw this. */
export class CoretaxPreflightError extends Error {
  readonly issues: readonly CoretaxPreflightIssue[];

  constructor(issues: readonly CoretaxPreflightIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.reason}`).join("; "));
    this.name = "CoretaxPreflightError";
    this.issues = issues;
  }
}

/** Thrown when the withholder NPWP or NITKU cannot head a file. No slip XML is returned. */
export class CoretaxWithholderError extends Error {
  readonly issues: readonly CoretaxFieldIssue[];

  constructor(issues: readonly CoretaxFieldIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.reason}`).join("; "));
    this.name = "CoretaxWithholderError";
    this.issues = issues;
  }
}

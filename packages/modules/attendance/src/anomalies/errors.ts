import type { FieldIssue } from "@gotonghr/contracts";

export class AnomalyError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: string;
  readonly fields: FieldIssue[];

  constructor(
    status: 400 | 403 | 404 | 409,
    code: string,
    message: string,
    fields: FieldIssue[] = [],
  ) {
    super(message);
    this.name = "AnomalyError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function missingPermission(): AnomalyError {
  return new AnomalyError(403, "forbidden", "Missing permission.");
}

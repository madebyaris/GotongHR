export class PayrollError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422 | 500;
  readonly code: string;
  readonly fields: readonly { field: string; message: string }[];

  constructor(
    status: 400 | 403 | 404 | 409 | 422 | 500,
    code: string,
    message: string,
    fields: readonly { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "PayrollError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function invalid(field: string, message: string): PayrollError {
  return new PayrollError(400, "invalid_field", `${field} ${message}`);
}

export class ScheduleError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: string;

  constructor(status: 400 | 403 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = "ScheduleError";
    this.status = status;
    this.code = code;
  }
}

export function invalid(field: string, message: string): ScheduleError {
  return new ScheduleError(400, "invalid_field", `${field} ${message}`);
}

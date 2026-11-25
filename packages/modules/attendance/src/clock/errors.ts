import type { FieldIssue } from "@gotonghr/contracts";

export class ClockFieldError extends Error {
  readonly fields: FieldIssue[];

  constructor(fields: FieldIssue[]) {
    super("Check the highlighted fields.");
    this.name = "ClockFieldError";
    this.fields = fields;
  }
}

export class ClockForbiddenError extends Error {
  constructor(message = "That branch is outside your scope.") {
    super(message);
    this.name = "ClockForbiddenError";
  }
}

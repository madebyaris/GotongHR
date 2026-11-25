import type { FieldIssue } from "@gotonghr/contracts";

export class EmployeeFieldError extends Error {
  readonly fields: FieldIssue[];
  readonly statusCode = 400;

  constructor(fields: FieldIssue[]) {
    super("Check the highlighted fields.");
    this.name = "EmployeeFieldError";
    this.fields = fields;
  }
}

export class EmployeeNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super("That employee was not found.");
    this.name = "EmployeeNotFoundError";
  }
}

export class EmployeeConflictError extends Error {
  readonly fields: FieldIssue[];
  readonly statusCode = 409;

  constructor(fields: FieldIssue[]) {
    super("That value is already used.");
    this.name = "EmployeeConflictError";
    this.fields = fields;
  }
}

export class EmployeeForbiddenError extends Error {
  readonly statusCode = 403;

  constructor(message = "That employee is outside your scope.") {
    super(message);
    this.name = "EmployeeForbiddenError";
  }
}

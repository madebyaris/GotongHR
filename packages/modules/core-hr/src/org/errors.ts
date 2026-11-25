import type { FieldIssue } from "@gotonghr/contracts";
import { EmployeeForbiddenError } from "../errors.ts";
import { errorCode, errorConstraint } from "../sql.ts";

export class OrgFieldError extends Error {
  readonly fields: FieldIssue[];
  readonly statusCode = 400;

  constructor(fields: FieldIssue[]) {
    super("Check the highlighted fields.");
    this.name = "OrgFieldError";
    this.fields = fields;
  }
}

export class OrgNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = "OrgNotFoundError";
  }
}

export class OrgConflictError extends Error {
  readonly fields: FieldIssue[];
  readonly statusCode = 409;

  constructor(fields: FieldIssue[]) {
    super(fields[0]?.message ?? "That value is already used.");
    this.name = "OrgConflictError";
    this.fields = fields;
  }
}

export function mapOrgError(error: unknown): unknown {
  if (
    error instanceof OrgFieldError ||
    error instanceof OrgNotFoundError ||
    error instanceof OrgConflictError ||
    error instanceof EmployeeForbiddenError
  ) {
    return error;
  }
  const code = errorCode(error);
  const constraint = errorConstraint(error);
  const message = error instanceof Error ? error.message : "";
  if (code === "23505") return new OrgConflictError(conflictFields(constraint));
  if (code === "23503") {
    return new OrgFieldError([
      { field: foreignKeyField(constraint), message: "That link was not found in this company." },
    ]);
  }
  if (code === "23514" && message.includes("append-only")) {
    return new OrgConflictError([
      { field: "baseSalaryIdr", message: "Add a new compensation profile. Pay is not edited in place." },
    ]);
  }
  if (code === "23514") {
    return new OrgFieldError([{ field: "body", message: "A value does not match the rules." }]);
  }
  return error;
}

function conflictFields(constraint: string): FieldIssue[] {
  if (constraint.includes("code")) return [{ field: "code", message: "This code is already used." }];
  if (constraint.includes("open")) {
    return [{ field: "effectiveFrom", message: "That employee already has an open compensation profile." }];
  }
  if (constraint.includes("start") || constraint.includes("effective")) {
    return [{ field: "effectiveFrom", message: "A profile already starts on that date." }];
  }
  if (constraint.includes("dedupe")) {
    return [{ field: "dedupeKey", message: "That expiry notice was already recorded." }];
  }
  return [{ field: "body", message: "That value is already used." }];
}

function foreignKeyField(constraint: string): string {
  if (constraint.includes("parent")) return "parentDepartmentId";
  if (constraint.includes("reports")) return "reportsToPositionId";
  if (constraint.includes("manager")) return "managerEmployeeId";
  if (constraint.includes("position")) return "positionId";
  if (constraint.includes("department")) return "departmentId";
  if (constraint.includes("employee")) return "employeeId";
  if (constraint.includes("branch")) return "branchId";
  if (constraint.includes("entity")) return "legalEntityId";
  return "body";
}

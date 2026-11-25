export const EMPLOYEE_IMPORT_QUEUE = "gotong.employees.import";

export interface EmployeeImportMessage {
  tenantId: string;
  importJobId: string;
}

/** Commit writes every row or none. The API repeats this on the job payload. */
export const ALL_OR_NOTHING_ROLLBACK =
  "All-or-nothing rollback: no employees were written because one or more rows failed.";

export const DRY_RUN_WRITES_NOTHING = "Dry run writes no employees.";

export const MAX_IMPORT_ROWS = 2000;
export const MAX_STORED_LINE_ERRORS = 500;

export interface ImportLineError {
  line: number;
  field: string;
  message: string;
}

export interface ImportJobError {
  code: "import_rolled_back" | "dry_run" | "committed";
  message: string;
  allOrNothing: true;
  written: number;
}

export type ImportMode = "dry_run" | "commit";
export type ImportStatus = "queued" | "running" | "completed" | "failed";

export interface ImportJobView {
  id: string;
  status: ImportStatus;
  mode: ImportMode;
  allOrNothing: true;
  totalRows: number;
  validRows: number;
  errorRows: number;
  writtenRows: number;
  lineErrors: ImportLineError[];
  error: ImportJobError | null;
}

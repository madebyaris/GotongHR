export class PayrollInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollInputError";
  }
}

export class InvalidStatutoryTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStatutoryTableError";
  }
}

/** Thrown when a calculation needs a statutory figure the table marks missing. */
export class MissingStatutoryValueError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Statutory value "${key}" is missing. The engine does not substitute a rate or amount.`,
    );
    this.name = "MissingStatutoryValueError";
    this.key = key;
  }
}

export class GrossUpDidNotConvergeError extends Error {
  constructor() {
    super("Gross-up did not converge within 10 iterations.");
    this.name = "GrossUpDidNotConvergeError";
  }
}

export class GoldenCaseMismatchError extends Error {
  readonly caseId: string;
  readonly field: string;

  constructor(caseId: string, field: string, expected: bigint, actual: bigint) {
    super(
      `Verified case ${caseId} ${field} is ${actual.toString()}, expected ${expected.toString()}.`,
    );
    this.name = "GoldenCaseMismatchError";
    this.caseId = caseId;
    this.field = field;
  }
}

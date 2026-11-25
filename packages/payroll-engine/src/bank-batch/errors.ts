/** Thrown when the debit account or effective date cannot head a file. Row problems are exclusions, not this error. */
export class BankBatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankBatchInputError";
  }
}

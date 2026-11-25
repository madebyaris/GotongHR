export class PiiRevealDeniedError extends Error {
  readonly statusCode = 403;
  readonly code = "forbidden";

  constructor() {
    super("employee.pii.reveal is required");
    this.name = "PiiRevealDeniedError";
  }
}

export class SupportGrantPiiDeniedError extends Error {
  readonly statusCode = 403;
  readonly code = "pii_reveal_denied";

  constructor() {
    super("Support grant does not allow PII reveal.");
    this.name = "SupportGrantPiiDeniedError";
  }
}

export class PiiRevealReasonError extends Error {
  readonly statusCode = 400;
  readonly code = "reason_required";

  constructor() {
    super("A reveal reason is required.");
    this.name = "PiiRevealReasonError";
  }
}

export class AuditChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditChainError";
  }
}

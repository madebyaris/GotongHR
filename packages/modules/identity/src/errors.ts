export class SingleTenantOccupiedError extends Error {
  readonly code = "single_tenant_occupied" as const;

  constructor() {
    super("single_tenant mode already has a tenant");
    this.name = "SingleTenantOccupiedError";
  }
}

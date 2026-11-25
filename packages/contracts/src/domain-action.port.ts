/**
 * Runs a confirmed proposal against a domain module.
 * Slice 5.1 does not import core HR. The API injects an executor.
 * Tool execution must not call this. Only a successful confirm does.
 */
export interface DomainActionCommand {
  tenantId: string;
  actorUserId: string;
  proposalId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface DomainActionExecutor {
  execute(command: DomainActionCommand): Promise<Record<string, unknown>>;
}

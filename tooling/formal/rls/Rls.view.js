export const title = "A tenant sees only its own rows";

export const state = (v) => {
  if (v.grantPhase === "active") return "Support session";
  if (v.grantPhase === "issued") return "Grant waiting";
  if (v.grantPhase === "expired") return "Grant expired";
  if (v.grantPhase === "revoked") return "Grant revoked";
  if (v.grantPhase === "spent") return "Grant used";
  const open = Object.values(v.phase).some((phase) => phase === "tx");
  return open ? "Tenant transaction" : "Pool idle";
};

export const step = (action) => {
  if (action === "BeginTenant") return "the tenant opens a transaction";
  if (action === "ReadNoPredicate") return "a query with no tenant filter";
  if (action === "WriteNoPredicate") return "a write with no tenant filter";
  if (action === "Commit") return "the connection returns to the pool";
  if (action === "Issue") return "the tenant issues a grant";
  if (action === "Activate") return "the operator uses the grant";
  if (action === "Expire") return "the grant expires";
  if (action === "Revoke") return "the tenant revokes the grant";
  if (action === "PlatformRead") return "the operator reads sensitive rows";
  if (action === "RevealPii") return "the operator reveals PII";
  return null;
};

export const group = (v) => {
  if (v.grantPhase === "active") return "support";
  if (v.grantPhase === "issued") return "waiting";
  return "closed";
};

export const colors = {
  support: "teal",
  waiting: "yellow",
  closed: "tan",
};

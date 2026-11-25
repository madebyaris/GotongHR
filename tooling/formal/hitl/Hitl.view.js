export const title = "A proposal waits for a person";

export const state = (v) => {
  if (v.status === "none") return "No proposal";
  if (v.status === "pending") return "Waiting";
  if (v.status === "executed") return "Applied once";
  if (v.status === "rejected") return "Rejected";
  return "Expired";
};

export const step = (action) => {
  if (action === "Propose") return "the assistant proposes a change";
  if (action === "Confirm") return "you confirm";
  if (action === "Reject") return "you reject";
  if (action === "Expire") return "the proposal expires";
  return null;
};

export const group = (v) => {
  if (v.status === "executed") return "applied";
  if (v.status === "pending") return "waiting";
  return "closed";
};

export const colors = {
  waiting: "yellow",
  applied: "teal",
  closed: "tan",
};

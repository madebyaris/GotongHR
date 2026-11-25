export const title = "A payroll run freezes once";

export const state = (v) => {
  if (v.status === "draft") return "Draft";
  if (v.status === "calculated") return "Calculated";
  if (v.status === "approved") return "Approved";
  return "Finalized";
};

export const step = (action) => {
  if (action === "Calculate") return "payroll calculates the month";
  if (action === "Approve") return "a reviewer approves";
  if (action === "Finalize") return "finalize enqueues one PDF batch";
  if (action === "SecondFinalize") return "a second finalize enqueues nothing";
  if (action === "MutateAfterFinalize") return "a later edit leaves the money";
  return null;
};

export const group = (v) => {
  if (v.status === "finalized") return "frozen";
  if (v.status === "draft") return "open";
  return "review";
};

export const colors = {
  open: "tan",
  review: "yellow",
  frozen: "teal",
};

---- MODULE PayrollRun ----
EXTENDS Naturals

VARIABLES status, money, pdfBatches

vars == <<status, money, pdfBatches>>

Init ==
  /\ status = "draft"
  /\ money = 0
  /\ pdfBatches = 0

Calculate ==
  /\ status = "draft"
  /\ status' = "calculated"
  /\ money' = 1
  /\ UNCHANGED pdfBatches

Approve ==
  /\ status = "calculated"
  /\ status' = "approved"
  /\ UNCHANGED <<money, pdfBatches>>

Finalize ==
  /\ status = "approved"
  /\ status' = "finalized"
  /\ pdfBatches' = pdfBatches + 1
  /\ UNCHANGED money

\* A second or concurrent finalize finds the run already finalized and enqueues nothing.
SecondFinalize ==
  /\ status = "finalized"
  /\ UNCHANGED vars

\* Money on a finalized line does not change.
MutateAfterFinalize ==
  /\ status = "finalized"
  /\ UNCHANGED vars

Next ==
  \/ Calculate
  \/ Approve
  \/ Finalize
  \/ SecondFinalize
  \/ MutateAfterFinalize

Spec == Init /\ [][Next]_vars

\* Status moves only draft, calculated, approved, finalized.
StatusOrder == status \in {"draft", "calculated", "approved", "finalized"}

\* Draft has no money snapshot. Later statuses keep the calculated money.
MoneyFrozen ==
  /\ (status = "draft" => money = 0)
  /\ (status \in {"calculated", "approved", "finalized"} => money = 1)

\* One finalize enqueues one PDF batch. A second finalize does not enqueue another.
SinglePdfBatch ==
  /\ pdfBatches <= 1
  /\ (status = "finalized" => pdfBatches = 1 /\ money = 1)
  /\ (status # "finalized" => pdfBatches = 0)

====

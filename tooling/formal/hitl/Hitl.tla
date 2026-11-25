---- MODULE Hitl ----
EXTENDS Naturals

VARIABLES status, domain, runs

vars == <<status, domain, runs>>

Init ==
  /\ status = "none"
  /\ domain = 0
  /\ runs = 0

Propose ==
  /\ status = "none"
  /\ status' = "pending"
  /\ UNCHANGED <<domain, runs>>

Confirm ==
  /\ status = "pending"
  /\ status' = "executed"
  /\ domain' = domain + 1
  /\ runs' = runs + 1

Reject ==
  /\ status = "pending"
  /\ status' = "rejected"
  /\ UNCHANGED <<domain, runs>>

Expire ==
  /\ status = "pending"
  /\ status' = "expired"
  /\ UNCHANGED <<domain, runs>>

WrongConfirm ==
  /\ status = "pending"
  /\ UNCHANGED vars

SecondConfirm ==
  /\ status /= "pending"
  /\ UNCHANGED vars

Done ==
  /\ status \in {"none", "executed", "rejected", "expired"}
  /\ UNCHANGED vars

Next ==
  \/ Propose
  \/ Confirm
  \/ Reject
  \/ Expire
  \/ WrongConfirm
  \/ SecondConfirm
  \/ Done

Spec == Init /\ [][Next]_vars

\* A pending proposal has not changed the domain.
PendingLeavesDomain == status = "pending" => domain = 0

\* One successful confirm applies the action once.
ExecutedOnce == status = "executed" => domain = 1 /\ runs = 1

\* Reject, expiry, and the starting state leave the domain unchanged.
ClosedLeavesDomain == status \in {"none", "rejected", "expired"} => domain = 0

\* The domain version matches the number of executions, and that number is at most one.
RunsMatchDomain == domain = runs /\ runs <= 1

====

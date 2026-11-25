---- MODULE Rls ----
\* Connection pool, transaction-local tenant GUC, and one support grant.
\* This is the pool and the grant, not the whole HRIS.
\*
\* Code this model follows at the sync commit named in the skill:
\*   packages/db/src/client.ts
\*     withTenantContext calls set_config('app.current_tenant_id', tenant, true)
\*   packages/db/src/policy.ts
\*     USING/WITH CHECK compare tenant_id to that setting, with no query predicate
\*   packages/db/src/migrate.ts
\*     platform_admin is created NOBYPASSRLS
\*   packages/modules/platform/src/grants.ts
\*     one activation, then expiry and revocation refuse the session
\*   packages/modules/audit/src/reveal.ts
\*     allow_pii_reveal false refuses plaintext

EXTENDS Naturals

CONSTANTS Tenants, Conns

VARIABLES
  phase, caller, localGuc, sessionGuc,
  grantPhase, grantTenant, allowPii, tokenUsed,
  seenSensitive, seenPii,
  badRead, badWrite, bypass

vars == <<
  phase, caller, localGuc, sessionGuc,
  grantPhase, grantTenant, allowPii, tokenUsed,
  seenSensitive, seenPii,
  badRead, badWrite, bypass
>>

None == "none"
Idle == "idle"
Tx == "tx"
Platform == "platform"
Masked == "masked"
Raw == "raw"

\* set_config(..., is_local = TRUE) installs t for this transaction only.
\* A scratch that omits set_config replaces this body with sessionGuc[c].
ScopedTenant(c, t) == t

\* SET LOCAL is discarded at commit, so the pooled session does not keep the tenant.
\* A scratch that omits the pool reset replaces this body with localGuc[c].
ReleasedGuc(c) == None

Init ==
  /\ phase = [c \in Conns |-> Idle]
  /\ caller = [c \in Conns |-> None]
  /\ localGuc = [c \in Conns |-> None]
  /\ sessionGuc = [c \in Conns |-> None]
  /\ grantPhase = None
  /\ grantTenant = None
  /\ allowPii = FALSE
  /\ tokenUsed = FALSE
  /\ seenSensitive = [c \in Conns |-> None]
  /\ seenPii = [c \in Conns |-> None]
  /\ badRead = FALSE
  /\ badWrite = FALSE
  /\ bypass = FALSE

\* Inside a transaction, the local GUC wins. Otherwise the session value remains.
Effective(c) ==
  IF localGuc[c] /= None THEN localGuc[c] ELSE sessionGuc[c]

Blank(c) ==
  /\ phase' = [phase EXCEPT ![c] = Idle]
  /\ caller' = [caller EXCEPT ![c] = None]
  /\ localGuc' = [localGuc EXCEPT ![c] = ReleasedGuc(c)]
  /\ sessionGuc' = [sessionGuc EXCEPT ![c] = ReleasedGuc(c)]
  /\ seenSensitive' = [seenSensitive EXCEPT ![c] = None]
  /\ seenPii' = [seenPii EXCEPT ![c] = None]

\* withTenantContext for a tenant: BEGIN, then set_config(..., true).
BeginTenant(c, t) ==
  /\ phase[c] = Idle
  /\ t \in Tenants
  /\ phase' = [phase EXCEPT ![c] = Tx]
  /\ caller' = [caller EXCEPT ![c] = t]
  /\ localGuc' = [localGuc EXCEPT ![c] = ScopedTenant(c, t)]
  /\ UNCHANGED <<sessionGuc, grantPhase, grantTenant, allowPii, tokenUsed,
                 seenSensitive, seenPii, badRead, badWrite, bypass>>

\* SELECT with no tenant_id predicate. The policy keeps rows of Effective(c) only.
ReadNoPredicate(c) ==
  /\ phase[c] = Tx
  /\ caller[c] \in Tenants
  /\ LET visible == Effective(c)
     IN badRead' = badRead \/ (visible /= None /\ visible /= caller[c])
  /\ UNCHANGED <<phase, caller, localGuc, sessionGuc, grantPhase, grantTenant,
                 allowPii, tokenUsed, seenSensitive, seenPii, badWrite, bypass>>

\* UPDATE or INSERT with no tenant_id predicate.
\* WITH CHECK writes a row only when that row's tenant is Effective(c).
WriteNoPredicate(c, rowTenant) ==
  /\ phase[c] = Tx
  /\ caller[c] \in Tenants
  /\ rowTenant \in Tenants
  /\ LET visible == Effective(c)
         wroteOther == visible = rowTenant /\ rowTenant /= caller[c]
     IN badWrite' = badWrite \/ wroteOther
  /\ UNCHANGED <<phase, caller, localGuc, sessionGuc, grantPhase, grantTenant,
                 allowPii, tokenUsed, seenSensitive, seenPii, badRead, bypass>>

Commit(c) ==
  /\ phase[c] = Tx
  /\ Blank(c)
  /\ IF caller[c] = Platform /\ grantPhase = "active"
     THEN grantPhase' = "spent"
     ELSE UNCHANGED grantPhase
  /\ UNCHANGED <<grantTenant, allowPii, tokenUsed, badRead, badWrite, bypass>>

\* A new grant is unused. A later grant is allowed only after the previous one ended.
Issue(t, reveal) ==
  /\ grantPhase \in {None, "expired", "revoked", "spent"}
  /\ \A c \in Conns : caller[c] /= Platform
  /\ t \in Tenants
  /\ reveal \in BOOLEAN
  /\ grantPhase' = "issued"
  /\ grantTenant' = t
  /\ allowPii' = reveal
  /\ tokenUsed' = FALSE
  /\ UNCHANGED <<phase, caller, localGuc, sessionGuc, seenSensitive, seenPii,
                 badRead, badWrite, bypass>>

\* Expiry or revocation closes a platform view before another sensitive read.
ClosePlatform ==
  /\ phase' = [c \in Conns |-> IF caller[c] = Platform THEN Idle ELSE phase[c]]
  /\ caller' = [c \in Conns |-> IF caller[c] = Platform THEN None ELSE caller[c]]
  /\ localGuc' = [c \in Conns |-> IF caller[c] = Platform THEN None ELSE localGuc[c]]
  /\ sessionGuc' = [c \in Conns |-> IF caller[c] = Platform THEN None ELSE sessionGuc[c]]
  /\ seenSensitive' = [c \in Conns |-> IF caller[c] = Platform THEN None ELSE seenSensitive[c]]
  /\ seenPii' = [c \in Conns |-> IF caller[c] = Platform THEN None ELSE seenPii[c]]

Expire ==
  /\ grantPhase \in {"issued", "active"}
  /\ grantPhase' = "expired"
  /\ ClosePlatform
  /\ UNCHANGED <<grantTenant, allowPii, tokenUsed, badRead, badWrite, bypass>>

Revoke ==
  /\ grantPhase \in {"issued", "active"}
  /\ grantPhase' = "revoked"
  /\ ClosePlatform
  /\ UNCHANGED <<grantTenant, allowPii, tokenUsed, badRead, badWrite, bypass>>

\* The token activates once. The session GUC is the grant tenant, via set_config.
Activate(c) ==
  /\ phase[c] = Idle
  /\ grantPhase = "issued"
  /\ ~ tokenUsed
  /\ grantTenant \in Tenants
  /\ phase' = [phase EXCEPT ![c] = Tx]
  /\ caller' = [caller EXCEPT ![c] = Platform]
  /\ localGuc' = [localGuc EXCEPT ![c] = ScopedTenant(c, grantTenant)]
  /\ grantPhase' = "active"
  /\ tokenUsed' = TRUE
  /\ UNCHANGED <<sessionGuc, grantTenant, allowPii, seenSensitive, seenPii,
                 badRead, badWrite, bypass>>

\* A second activation does not open a session.
SecondActivate(c) ==
  /\ tokenUsed
  /\ phase[c] = Idle
  /\ UNCHANGED vars

\* platform_admin has no BYPASSRLS and no grant, so this role sees no tenant rows.
BarePlatformRead(c) ==
  /\ ~ bypass
  /\ phase[c] = Idle
  /\ UNCHANGED vars

\* The app pool. An empty GUC returns no rows. A leftover GUC still matches RLS.
IdleRead(c) ==
  /\ phase[c] = Idle
  /\ badRead' = badRead \/ bypass \/ sessionGuc[c] /= None
  /\ UNCHANGED <<phase, caller, localGuc, sessionGuc, grantPhase, grantTenant,
                 allowPii, tokenUsed, seenSensitive, seenPii, badWrite, bypass>>

\* Employee PII, payslips, payroll, and attendance rows of the grant tenant.
\* Plaintext is not returned here.
PlatformRead(c) ==
  /\ phase[c] = Tx
  /\ caller[c] = Platform
  /\ grantPhase = "active"
  /\ tokenUsed
  /\ ~ bypass
  /\ localGuc[c] = grantTenant
  /\ grantTenant \in Tenants
  /\ seenSensitive' = [seenSensitive EXCEPT ![c] = grantTenant]
  /\ seenPii' = [seenPii EXCEPT ![c] = Masked]
  /\ UNCHANGED <<phase, caller, localGuc, sessionGuc, grantPhase, grantTenant,
                 allowPii, tokenUsed, badRead, badWrite, bypass>>

\* revealPii returns plaintext only when allow_pii_reveal is true.
RevealPii(c) ==
  /\ phase[c] = Tx
  /\ caller[c] = Platform
  /\ grantPhase = "active"
  /\ tokenUsed
  /\ ~ bypass
  /\ localGuc[c] = grantTenant
  /\ allowPii
  /\ seenSensitive' = [seenSensitive EXCEPT ![c] = grantTenant]
  /\ seenPii' = [seenPii EXCEPT ![c] = Raw]
  /\ UNCHANGED <<phase, caller, localGuc, sessionGuc, grantPhase, grantTenant,
                 allowPii, tokenUsed, badRead, badWrite, bypass>>

Next ==
  \/ \E c \in Conns, t \in Tenants : BeginTenant(c, t)
  \/ \E c \in Conns : ReadNoPredicate(c)
  \/ \E c \in Conns, t \in Tenants : WriteNoPredicate(c, t)
  \/ \E c \in Conns : Commit(c)
  \/ \E t \in Tenants : Issue(t, TRUE) \/ Issue(t, FALSE)
  \/ Expire
  \/ Revoke
  \/ \E c \in Conns : Activate(c)
  \/ \E c \in Conns : SecondActivate(c)
  \/ \E c \in Conns : BarePlatformRead(c)
  \/ \E c \in Conns : IdleRead(c)
  \/ \E c \in Conns : PlatformRead(c)
  \/ \E c \in Conns : RevealPii(c)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in [Conns -> {Idle, Tx}]
  /\ caller \in [Conns -> (Tenants \cup {None, Platform})]
  /\ localGuc \in [Conns -> (Tenants \cup {None})]
  /\ sessionGuc \in [Conns -> (Tenants \cup {None})]
  /\ grantPhase \in {None, "issued", "active", "expired", "revoked", "spent"}
  /\ grantTenant \in (Tenants \cup {None})
  /\ allowPii \in BOOLEAN
  /\ tokenUsed \in BOOLEAN
  /\ seenSensitive \in [Conns -> (Tenants \cup {None})]
  /\ seenPii \in [Conns -> {None, Masked, Raw}]
  /\ badRead \in BOOLEAN
  /\ badWrite \in BOOLEAN
  /\ bypass \in BOOLEAN

\* A tenant read never returns the other tenant's row.
NoCrossTenantRead == ~ badRead

\* A tenant write never changes the other tenant's row.
NoCrossTenantWrite == ~ badWrite

\* An idle pooled connection does not still hold app.current_tenant_id.
PoolDoesNotLeakTenant ==
  \A c \in Conns :
    phase[c] = Idle => sessionGuc[c] = None /\ localGuc[c] = None

\* withTenantContext has set the transaction-local GUC to the caller.
TenantTxSetsLocalGuc ==
  \A c \in Conns :
    (phase[c] = Tx /\ caller[c] \in Tenants) => localGuc[c] = caller[c]

\* A visible PII, payroll, or attendance row belongs to a live grant.
PlatformNeedsLiveGrant ==
  \A c \in Conns :
    seenSensitive[c] /= None =>
      /\ phase[c] = Tx
      /\ caller[c] = Platform
      /\ grantPhase = "active"
      /\ tokenUsed
      /\ ~ bypass
      /\ localGuc[c] = seenSensitive[c]
      /\ seenSensitive[c] = grantTenant

\* Raw PII is returned only when allow_pii_reveal is true.
PiiRevealNeedsAllow ==
  \A c \in Conns : seenPii[c] = Raw => allowPii /\ seenSensitive[c] /= None

\* The platform role does not bypass row security.
PlatformAdminNoBypass == bypass = FALSE

\* The current token activates once. A platform transaction is that activation.
GrantActivatesOnce ==
  /\ (grantPhase = "issued") => ~ tokenUsed
  /\ grantPhase \in {"active", "spent"} => tokenUsed
  /\ \A c \in Conns :
       caller[c] = Platform =>
         /\ phase[c] = Tx
         /\ grantPhase = "active"
         /\ tokenUsed
         /\ localGuc[c] = grantTenant
         /\ grantTenant \in Tenants

====

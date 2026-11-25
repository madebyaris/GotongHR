import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  impactDiff,
  impactLines,
  impactSummary,
  impactWarnings,
  maskSensitiveText,
  type AssistantProposal,
} from "@/lib/assistant";

export type CardStatus = AssistantProposal["status"] | "conflict";

export function ProposalCard({
  proposal,
  busy,
  error,
  onConfirm,
  onReject,
}: {
  proposal: AssistantProposal;
  busy: boolean;
  error: string | null;
  onConfirm: (code: string) => void;
  onReject: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState("");
  const summary = maskSensitiveText(impactSummary(proposal.impactPreview, proposal.toolName));
  const diff = impactDiff(proposal.impactPreview);
  const lines = impactLines(proposal.impactPreview).map((line) => maskSensitiveText(line));
  const pending = proposal.status === "pending";
  const expired = pending && new Date(proposal.expiresAt).getTime() <= now;
  const status = expired ? "expired" : proposal.status;
  const warnings =
    status === "pending" || status === "expired"
      ? impactWarnings(proposal.impactPreview).map((warning) => maskSensitiveText(warning))
      : [];
  const needsCode = proposal.requiresTotp && status === "pending" && !expired;
  const codeReady = !needsCode || /^\d{6}$/u.test(code);

  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [pending]);

  return (
    <article className="border border-border p-4" aria-labelledby={`proposal-${proposal.id}-title`}>
      <p className="text-sm font-medium text-muted-foreground">{eyebrow(status)}</p>
      <h2 className="mt-1 text-lg font-semibold" id={`proposal-${proposal.id}-title`}>
        {summary}
      </h2>
      {diff.length > 0 ? (
        <dl className="mt-4">
          {diff.map((row) => (
            <div key={row.label} className="grid grid-cols-1 gap-1 border-t border-border py-3 sm:grid-cols-[8rem_1fr_1fr] sm:gap-3">
              <dt className="text-sm font-medium text-muted-foreground">{row.label}</dt>
              <dd>
                <span className="block text-sm text-muted-foreground">Before</span>
                <span className="text-base">{row.before}</span>
              </dd>
              <dd>
                <span className="block text-sm text-muted-foreground">After</span>
                <span className="text-base font-medium">{row.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ul className="mt-2 text-base">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {warnings.length > 0 ? (
        <ul className="mt-3 list-disc pl-5 text-base" aria-label="Warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-4 text-base font-medium" role="status">
        {statusText(status, proposal.expiresAt, now)}
      </p>
      {needsCode ? (
        <div className="mt-4">
          <label className="block text-base font-medium" htmlFor={`totp-${proposal.id}`}>
            Authenticator code
          </label>
          <p className="mt-1 text-sm text-muted-foreground" id={`totp-${proposal.id}-hint`}>
            Payroll finalize needs the 6-digit code from your authenticator.
          </p>
          <input
            id={`totp-${proposal.id}`}
            className="mt-2 box-border h-11 w-full max-w-[12rem] rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            aria-describedby={`totp-${proposal.id}-hint`}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
          />
        </div>
      ) : null}
      {error ? (
        <p className="mt-3 text-base text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {status === "pending" && !expired ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button
            className="min-h-11 text-base sm:min-w-36"
            type="button"
            disabled={busy || !codeReady}
            aria-busy={busy}
            onClick={() => onConfirm(code)}
          >
            {busy ? "Confirming…" : "Confirm"}
          </Button>
          <Button className="min-h-11 text-base sm:min-w-36" type="button" variant="outline" disabled={busy} onClick={onReject}>
            Reject
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function eyebrow(status: CardStatus): string {
  if (status === "executed") return "Confirmed";
  if (status === "rejected") return "Rejected";
  if (status === "expired") return "Expired";
  if (status === "conflict") return "Already decided";
  return "Needs confirmation";
}

function statusText(status: CardStatus, expiresAt: string, now: number): string {
  if (status === "executed") return "Confirmed. The decision is saved in the audit log.";
  if (status === "rejected") return "Rejected. Nothing was changed.";
  if (status === "expired") return "Expired. Confirm is closed.";
  if (status === "conflict") return "Already decided. Confirm did not run again.";
  const remaining = new Date(expiresAt).getTime() - now;
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return minutes === 1 ? "Expires in 1 minute." : `Expires in ${minutes} minutes.`;
}

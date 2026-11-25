import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, apiData } from "@/lib/api";
import {
  maskSensitiveText,
  streamAssistant,
  type AssistantProposal,
  type ConversationThread,
} from "@/lib/assistant";
import { AdminFrame } from "./frame";
import { ProposalCard } from "./proposal-card";

const NONCE_KEY = "gotonghr.assistant.nonces";

interface Turn {
  id: string;
  kind: "user" | "assistant";
  text: string;
}

interface CardTurn {
  id: string;
  kind: "proposal";
  proposal: AssistantProposal;
  error: string | null;
}

type ThreadTurn = Turn | CardTurn;

export default function AssistantPage() {
  const navigate = useNavigate();
  const thread = useQuery({
    queryKey: ["ai", "latest"],
    queryFn: () => apiData<ConversationThread>("/api/v1/ai/conversations/latest"),
    retry: false,
  });

  useEffect(() => {
    if (thread.error instanceof ApiRequestError && thread.error.status === 401) {
      void navigate({ to: "/sign-in" });
    }
  }, [navigate, thread.error]);

  return (
    <AdminFrame>
      <main className="mx-auto flex w-full max-w-xl flex-col px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
        <p className="mt-2 text-base text-muted-foreground">Ask for a change. Nothing is saved until you confirm it.</p>
        {thread.isPending ? <p className="mt-6 text-base text-muted-foreground">Loading the thread…</p> : null}
        {thread.error && !(thread.error instanceof ApiRequestError && thread.error.status === 401) ? (
          <p className="mt-6 text-base" role="alert">
            The thread could not be loaded.
            <Button className="mt-4 min-h-11" type="button" onClick={() => void thread.refetch()}>
              Try again
            </Button>
          </p>
        ) : null}
        {thread.data ? <Conversation initial={thread.data} /> : null}
      </main>
    </AdminFrame>
  );
}

function Conversation({ initial }: { initial: ConversationThread }) {
  const [conversationId, setConversationId] = useState(initial.conversationId);
  const [turns, setTurns] = useState<ThreadTurn[]>(() => turnsFromThread(initial));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns, sending]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (message.length === 0 || sending) return;
    const assistantId = `assistant-${Date.now()}`;
    setDraft("");
    setFormError(null);
    setSending(true);
    setTurns((current) => [
      ...current,
      { id: `user-${Date.now()}`, kind: "user", text: maskSensitiveText(message) },
      { id: assistantId, kind: "assistant", text: "" },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAssistant(
        { message, ...(conversationId ? { conversationId } : {}) },
        (item) => {
          if (item.type === "token") {
            setTurns((current) => appendToken(current, assistantId, item.text));
          }
          if (item.type === "proposal") {
            rememberNonce(item.proposal);
            setTurns((current) => [...current, { id: item.proposal.id, kind: "proposal", proposal: item.proposal, error: null }]);
          }
          if (item.type === "done") setConversationId(item.conversationId);
          if (item.type === "error") setFormError(item.message);
        },
        controller.signal,
      );
    } catch {
      if (!controller.signal.aborted) setFormError("The reply stopped.");
    } finally {
      setSending(false);
    }
  }

  async function confirm(proposal: AssistantProposal, code: string) {
    const nonce = proposal.confirmationNonce ?? readNonce(proposal.id);
    if (!nonce) {
      setCardError(proposal.id, "Confirm this proposal from the reply that created it.");
      return;
    }
    setBusyId(proposal.id);
    setCardError(proposal.id, null);
    try {
      if (proposal.requiresTotp) {
        const verified = await fetch("/api/auth/two-factor/verify-totp", {
          method: "POST",
          credentials: "include",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (!verified.ok) {
          setCardError(proposal.id, "The authenticator code was not accepted.");
          return;
        }
      }
      const saved = await apiData<AssistantProposal>(`/api/v1/ai/proposals/${proposal.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ confirmationNonce: nonce, confirmation_nonce: nonce }),
      });
      setTurns((current) => replaceProposal(current, omitNonce(saved)));
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 409) {
        const nextStatus = caught.code === "expired" ? "expired" : "conflict";
        setTurns((current) => replaceProposal(current, omitNonce({ ...proposal, status: nextStatus })));
        return;
      }
      setCardError(proposal.id, caught instanceof ApiRequestError ? caught.message : "Confirm failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(proposal: AssistantProposal) {
    setBusyId(proposal.id);
    setCardError(proposal.id, null);
    try {
      const saved = await apiData<AssistantProposal>(`/api/v1/ai/proposals/${proposal.id}/reject`, { method: "POST" });
      setTurns((current) => replaceProposal(current, saved));
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 409) {
        setTurns((current) => replaceProposal(current, { ...proposal, status: "conflict" }));
        return;
      }
      setCardError(proposal.id, caught instanceof ApiRequestError ? caught.message : "Reject failed.");
    } finally {
      setBusyId(null);
    }
  }

  function setCardError(id: string, error: string | null) {
    setTurns((current) =>
      current.map((turn) => (turn.kind === "proposal" && turn.id === id ? { ...turn, error } : turn)),
    );
  }

  return (
    <>
      <ol className="mt-6 flex flex-col gap-4" aria-label="Conversation">
        {turns.length === 0 ? (
          <li className="text-base text-muted-foreground">No messages yet. The change you ask for shows up here.</li>
        ) : null}
        {turns.map((turn) =>
          turn.kind === "proposal" ? (
            <li key={turn.id}>
              <ProposalCard
                proposal={turn.proposal}
                busy={busyId === turn.proposal.id}
                error={turn.error}
                onConfirm={(code) => void confirm(turn.proposal, code)}
                onReject={() => void reject(turn.proposal)}
              />
            </li>
          ) : (
            <li key={turn.id} className={turn.kind === "user" ? "ml-8 border border-border px-3 py-2" : "mr-8"}>
              <p className="text-sm font-medium text-muted-foreground">{turn.kind === "user" ? "You" : "Assistant"}</p>
              <p className="mt-1 whitespace-pre-wrap text-base" aria-live={turn.kind === "assistant" ? "polite" : undefined}>
                {maskSensitiveText(turn.text)}
              </p>
            </li>
          ),
        )}
      </ol>
      <div ref={bottomRef} />
      <form className="mt-6" onSubmit={(event) => void onSubmit(event)}>
        {formError ? (
          <p className="mb-3 text-base text-destructive" role="alert">
            {formError}
          </p>
        ) : null}
        <label className="block text-base font-medium" htmlFor="assistant-message">
          Message
        </label>
        <textarea
          id="assistant-message"
          name="message"
          className="mt-1 box-border min-h-24 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:bg-muted"
          value={draft}
          disabled={sending}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button className="mt-4 min-h-11 text-base" type="submit" disabled={sending || draft.trim().length === 0}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </form>
    </>
  );
}

function turnsFromThread(thread: ConversationThread): ThreadTurn[] {
  const messages: ThreadTurn[] = thread.messages.map((message, index) => ({
    id: `${message.role}-${index}`,
    kind: message.role,
    text: message.content,
  }));
  const cards: ThreadTurn[] = thread.proposals.map((proposal) => {
    const nonce = proposal.confirmationNonce ?? readNonce(proposal.id);
    return {
      id: proposal.id,
      kind: "proposal" as const,
      proposal: nonce ? { ...proposal, confirmationNonce: nonce } : proposal,
      error: null,
    };
  });
  return [...messages, ...cards];
}

function appendToken(turns: ThreadTurn[], assistantId: string, text: string): ThreadTurn[] {
  return turns.map((turn) => (turn.id === assistantId && turn.kind === "assistant" ? { ...turn, text: turn.text + text } : turn));
}

function omitNonce(proposal: AssistantProposal): AssistantProposal {
  const { confirmationNonce: _nonce, ...rest } = proposal;
  return rest;
}

function replaceProposal(turns: ThreadTurn[], proposal: AssistantProposal): ThreadTurn[] {
  return turns.map((turn) => (turn.kind === "proposal" && turn.id === proposal.id ? { ...turn, proposal, error: null } : turn));
}

function rememberNonce(proposal: AssistantProposal): void {
  if (!proposal.confirmationNonce) return;
  const saved = readNonceMap();
  saved[proposal.id] = proposal.confirmationNonce;
  sessionStorage.setItem(NONCE_KEY, JSON.stringify(saved));
}

function readNonce(id: string): string | undefined {
  return readNonceMap()[id];
}

function readNonceMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(NONCE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

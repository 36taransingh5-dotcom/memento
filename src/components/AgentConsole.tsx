"use client";

import { useRef, useState } from "react";
import { DecisionTrace } from "@/components/DecisionTrace";
import { Card, CardTitle, cx } from "@/components/ui";
import type { AgentRunResult } from "@/lib/agent/types";
import type { UserWithTeam } from "@/lib/db/types";

/**
 * The operational console.
 *
 * Not a chat window. Each turn produces a decision with a full trace attached,
 * and the trace is the point — the conversation is just how the request arrives.
 * Follow-up turns carry the same `requestId`, so "use the existing one" continues
 * the same request rather than opening a new one.
 */

interface Turn {
  id: string;
  message: string;
  author: string;
  run: AgentRunResult | null;
  error: string | null;
}

const SUGGESTIONS = [
  "I need another GPU for my computer vision experiment.",
  "Can we add New Relic for backend monitoring? About $1,900 a month.",
  "We want to add a fourth node behind the production API.",
  "Okay, use the existing one.",
] as const;

export function AgentConsole({ users }: { users: UserWithTeam[] }) {
  const defaultUser =
    users.find((u) => u.email === "alex.chen@northstarlabs.io") ?? users[0];

  const [userId, setUserId] = useState<string>(defaultUser?.id ?? "");
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeUser = users.find((u) => u.id === userId) ?? defaultUser;

  // Follow-ups continue the request the last decision was about.
  const openRequestId =
    [...turns].reverse().find((t) => t.run?.requestId)?.run?.requestId ?? null;

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || !userId) return;

    const turnId = crypto.randomUUID();
    setTurns((prev) => [
      ...prev,
      {
        id: turnId,
        message: trimmed,
        author: activeUser?.name ?? "Requester",
        run: null,
        error: null,
      },
    ]);
    setMessage("");
    setBusy(true);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          message: trimmed,
          // Only continue an existing request when the wording reads like a
          // reply. A new subject should open a new request.
          requestId: isFollowUp(trimmed) ? openRequestId : null,
        }),
      });

      const payload: unknown = await response.json();

      if (!response.ok) {
        const error =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : "The agent could not complete this request.";
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, error } : t)),
        );
        return;
      }

      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId ? { ...t, run: payload as AgentRunResult } : t,
        ),
      );
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? {
                ...t,
                error:
                  err instanceof Error
                    ? `Could not reach the agent: ${err.message}`
                    : "Could not reach the agent.",
              }
            : t,
        ),
      );
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <label className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
              Acting as
            </span>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent disabled:opacity-60"
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} — {user.title || "member"}, {user.team_name}
                </option>
              ))}
            </select>
          </label>

          {openRequestId ? (
            <p className="text-[11px] text-ink-subtle">
              Follow-ups continue the open request.
            </p>
          ) : null}
        </div>

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(message);
          }}
        >
          <label htmlFor="agent-message" className="sr-only">
            Your request
          </label>
          <textarea
            id="agent-message"
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline. Operators type fast.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(message);
              }
            }}
            rows={3}
            disabled={busy}
            placeholder="Describe what you need — for example, “I need another GPU for my computer vision experiment.”"
            className="w-full resize-y rounded-lg border border-line bg-canvas px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-accent disabled:opacity-60"
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMessage(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
                >
                  {suggestion.length > 42
                    ? `${suggestion.slice(0, 40)}…`
                    : suggestion}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={busy || message.trim().length < 3}
              className={cx(
                "rounded-lg px-4 py-2 text-sm font-medium transition-opacity",
                busy || message.trim().length < 3
                  ? "cursor-not-allowed bg-surface-raised text-ink-subtle"
                  : "bg-accent text-canvas hover:opacity-90",
              )}
            >
              {busy ? "Working…" : "Send"}
            </button>
          </div>
        </form>
      </Card>

      {turns.length === 0 ? (
        <Card>
          <CardTitle>What happens when you send</CardTitle>
          <ol className="space-y-2 text-sm leading-relaxed text-ink-muted">
            <li>
              1. Your words are parsed into a structured request and persisted to
              CockroachDB.
            </li>
            <li>
              2. The agent queries structured memory — who you are, what your team
              holds, what is idle, what expires soon.
            </li>
            <li>
              3. It searches semantic memory by vector similarity for the context
              nobody indexed: why a similar request was refused, which vendor the
              organization settled on.
            </li>
            <li>
              4. Deterministic policy runs against the real data. A binding
              verdict cannot be overridden by the model.
            </li>
            <li>
              5. A decision is recorded with its full evidence trail — and becomes
              a memory the next request can retrieve.
            </li>
          </ol>
        </Card>
      ) : null}

      {turns.map((turn) => (
        <div key={turn.id} className="space-y-4">
          <div className="flex justify-end">
            <div className="max-w-xl rounded-2xl rounded-br-sm border border-line bg-surface-raised px-4 py-3">
              <p className="text-[11px] font-medium text-ink-subtle">
                {turn.author}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink">
                {turn.message}
              </p>
            </div>
          </div>

          {turn.run ? (
            <div className="animate-fade-up">
              <DecisionTrace run={turn.run} />
            </div>
          ) : turn.error ? (
            <Card className="border-reject-bg">
              <p className="text-xs font-medium text-reject">Agent error</p>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                {turn.error}
              </p>
            </Card>
          ) : (
            <Card>
              <div className="flex items-center gap-2.5">
                <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" />
                <p className="text-sm text-ink-muted">
                  Querying structured memory, searching vector memory, evaluating
                  policy…
                </p>
              </div>
            </Card>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Whether a message reads as a reply to the agent's last question rather than a
 * new subject. Conservative on purpose: misrouting a new request into an old one
 * is worse than opening a second request.
 */
function isFollowUp(message: string): boolean {
  return /\b(ok(ay)?|yes|sure|go ahead|do that|use (the )?(existing|that|it)|reuse|instead|that works|sounds good|proceed)\b/i.test(
    message,
  );
}

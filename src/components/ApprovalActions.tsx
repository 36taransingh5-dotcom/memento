"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cx } from "@/components/ui";
import type { User } from "@/lib/db/types";

/**
 * The human end of an escalation.
 *
 * Approving here is the only path by which a REQUEST_APPROVAL or
 * FLAG_FOR_REVIEW becomes an approval — the agent cannot grant itself the
 * authority it escalated for.
 */
export function ApprovalActions({
  approvalId,
  requiredRole,
  approvers,
}: {
  approvalId: string;
  requiredRole: "lead" | "admin";
  approvers: User[];
}) {
  const router = useRouter();
  const [approverId, setApproverId] = useState(approvers[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (approvers.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-inform">
        No one with the <strong>{requiredRole}</strong> role can resolve this
        escalation. Assign the role to a team member first.
      </p>
    );
  }

  async function resolve(status: "approved" | "rejected") {
    if (busy || !approverId) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/approvals/${approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approverId, status, note: note || undefined }),
      });

      const payload: unknown = await response.json();
      if (!response.ok) {
        setError(
          typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof payload.error === "string"
            ? payload.error
            : "Could not resolve the approval.",
        );
        return;
      }

      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not reach the server: ${err.message}`
          : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
          Resolving as
        </span>
        <select
          value={approverId}
          onChange={(e) => setApproverId(e.target.value)}
          disabled={busy}
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent disabled:opacity-60"
        >
          {approvers.map((approver) => (
            <option key={approver.id} value={approver.id}>
              {approver.name} — {approver.role}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
          Note (optional)
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          maxLength={1000}
          placeholder="Context the next decision should remember"
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-accent disabled:opacity-60"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void resolve("approved")}
          disabled={busy}
          className={cx(
            "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-opacity",
            busy
              ? "cursor-not-allowed bg-surface-raised text-ink-subtle"
              : "bg-approve-bg text-approve hover:opacity-80",
          )}
        >
          {busy ? "Working…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => void resolve("rejected")}
          disabled={busy}
          className={cx(
            "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-opacity",
            busy
              ? "cursor-not-allowed bg-surface-raised text-ink-subtle"
              : "bg-reject-bg text-reject hover:opacity-80",
          )}
        >
          Reject
        </button>
      </div>

      {error ? <p className="text-xs text-reject">{error}</p> : null}

      <p className="text-[11px] leading-relaxed text-ink-subtle">
        The outcome is written to memory, so the next comparable request can
        retrieve what a human decided here.
      </p>
    </div>
  );
}

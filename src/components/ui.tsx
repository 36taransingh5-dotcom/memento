import type { ReactNode } from "react";
import type { Decision, RequestStatus } from "@/lib/db/types";

/** Shared presentational primitives. Server-safe — no client hooks. */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// --- Layout ----------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={cx(
        "rounded-xl border border-line bg-surface",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
        {children}
      </h2>
      {hint ? (
        <span className="text-xs text-ink-subtle">{hint}</span>
      ) : null}
    </div>
  );
}

export function StatTile({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: "neutral" | "accent" | "warn";
}) {
  const valueTone =
    tone === "accent"
      ? "text-accent-ink"
      : tone === "warn"
        ? "text-inform"
        : "text-ink";

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
        {label}
      </div>
      <div className={cx("mt-2 text-3xl font-semibold tabular-nums", valueTone)}>
        {value}
      </div>
      {detail ? (
        <div className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-muted">{title}</p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-ink-subtle">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[0.85em] text-ink-muted">
      {children}
    </span>
  );
}

// --- Badges ----------------------------------------------------------------

const DECISION_STYLES: Readonly<Record<Decision, { bg: string; fg: string; label: string }>> = {
  APPROVE: {
    bg: "bg-approve-bg",
    fg: "text-approve",
    label: "Approve",
  },
  REJECT: {
    bg: "bg-reject-bg",
    fg: "text-reject",
    label: "Reject",
  },
  REQUEST_INFORMATION: {
    bg: "bg-inform-bg",
    fg: "text-inform",
    label: "Request information",
  },
  REQUEST_APPROVAL: {
    bg: "bg-approval-bg",
    fg: "text-approval",
    label: "Request approval",
  },
  FLAG_FOR_REVIEW: {
    bg: "bg-review-bg",
    fg: "text-review",
    label: "Flag for review",
  },
};

export function DecisionBadge({
  decision,
  size = "sm",
}: {
  decision: Decision;
  size?: "sm" | "lg";
}) {
  const style = DECISION_STYLES[decision];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md font-medium",
        style.bg,
        style.fg,
        size === "lg" ? "px-3 py-1.5 text-sm" : "px-2 py-0.5 text-xs",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {style.label}
    </span>
  );
}

const STATUS_LABELS: Readonly<Record<RequestStatus, string>> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  needs_information: "Needs information",
  under_review: "Under review",
  withdrawn: "Withdrawn",
  fulfilled: "Fulfilled",
};

const STATUS_STYLES: Readonly<Record<RequestStatus, string>> = {
  pending: "text-ink-muted",
  approved: "text-approve",
  rejected: "text-reject",
  needs_information: "text-inform",
  under_review: "text-review",
  withdrawn: "text-ink-subtle",
  fulfilled: "text-accent-ink",
};

export function StatusPill({ status }: { status: RequestStatus }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        STATUS_STYLES[status],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "hard" | "soft";
}) {
  const styles = {
    neutral: "border-line-strong text-ink-muted",
    accent: "border-accent-dim text-accent-ink",
    hard: "border-reject-bg text-reject",
    soft: "border-line-strong text-ink-subtle",
  } as const;

  return (
    <span
      className={cx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium",
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}

// --- Tables ----------------------------------------------------------------

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cx(
        "border-b border-line bg-surface px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cx(
        "border-b border-line px-4 py-3 align-top text-ink-muted",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

// --- Formatting ------------------------------------------------------------

export function formatDate(value: Date | string | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(value: Date | string | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const deltaMs = date.getTime() - Date.now();
  const deltaDays = Math.round(deltaMs / (24 * 60 * 60 * 1000));

  if (Math.abs(deltaDays) >= 1) {
    if (deltaDays === 1) return "tomorrow";
    if (deltaDays === -1) return "yesterday";
    return deltaDays > 0 ? `in ${deltaDays} days` : `${-deltaDays} days ago`;
  }

  const deltaHours = Math.round(deltaMs / (60 * 60 * 1000));
  if (Math.abs(deltaHours) >= 1) {
    return deltaHours > 0 ? `in ${deltaHours}h` : `${-deltaHours}h ago`;
  }

  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes === 0) return "just now";
  return deltaMinutes > 0 ? `in ${deltaMinutes}m` : `${-deltaMinutes}m ago`;
}

export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

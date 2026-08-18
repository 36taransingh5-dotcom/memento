"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

interface NavItem {
  href: string;
  label: string;
  /** Match the pathname exactly rather than by prefix — only "/" needs this. */
  exact?: boolean;
  /** Memory is the flagship surface; the badge names what powers it. */
  flagship?: boolean;
}

const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", exact: true },
  { href: "/agent", label: "Agent" },
  { href: "/requests", label: "Requests" },
  { href: "/resources", label: "Resources" },
  { href: "/memory", label: "Memory", flagship: true },
  { href: "/policies", label: "Policies" },
  { href: "/audit", label: "Audit log" },
];

/**
 * `rail` is the desktop vertical nav. `strip` is the same links laid out
 * horizontally for narrow viewports — a scrollable row rather than a drawer,
 * because this is an operator dashboard and a hidden menu is a menu nobody
 * opens.
 */
export function Sidebar({ variant = "rail" }: { variant?: "rail" | "strip" }) {
  const pathname = usePathname();
  const strip = variant === "strip";

  return (
    <nav
      aria-label={strip ? "Primary (compact)" : "Primary"}
      className={cx(
        "flex w-full gap-1",
        strip
          ? "items-center px-3 py-3"
          : "h-full flex-col px-3 py-5",
      )}
    >
      <Link
        href="/"
        className={cx(
          "flex items-center gap-2.5 px-2",
          strip ? "mr-2 shrink-0" : "mb-6",
        )}
      >
        <MementoMark />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-ink">
            Memento
          </div>
          {!strip ? (
            <div className="text-[11px] text-ink-subtle">Northstar Labs</div>
          ) : null}
        </div>
      </Link>

      {NAV.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "group flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
              strip && "shrink-0 whitespace-nowrap",
              active
                ? "bg-surface-raised text-ink"
                : "text-ink-muted hover:bg-surface hover:text-ink",
            )}
          >
            <span className="flex items-center gap-2.5">
              <span
                className={cx(
                  "size-1.5 rounded-full transition-colors",
                  active ? "bg-accent" : "bg-line-strong group-hover:bg-ink-subtle",
                )}
                aria-hidden
              />
              {item.label}
            </span>
            {item.flagship && !strip ? (
              <span className="rounded border border-accent-dim px-1 py-px text-[10px] font-medium text-accent-ink">
                vector
              </span>
            ) : null}
          </Link>
        );
      })}

      {!strip ? (
        <div className="mt-auto px-3 pt-6">
          <p className="text-[11px] leading-relaxed text-ink-subtle">
            Structured and semantic memory both live in CockroachDB. Reasoning
            runs on Amazon Bedrock.
          </p>
        </div>
      ) : null}
    </nav>
  );
}

/**
 * Three nodes and a link — structured fact, semantic memory, and the decision
 * they converge on. Small enough to read at 28px.
 */
function MementoMark() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <rect
        x="0.5"
        y="0.5"
        width="27"
        height="27"
        rx="7.5"
        stroke="var(--color-line-strong)"
      />
      <path
        d="M8 18.5V11a3 3 0 0 1 6 0v7.5"
        stroke="var(--color-ink-muted)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M14 18.5V11a3 3 0 0 1 6 0v7.5"
        stroke="var(--color-accent)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="20" cy="18.5" r="1.6" fill="var(--color-accent)" />
    </svg>
  );
}

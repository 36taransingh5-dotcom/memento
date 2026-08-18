import type { Metadata } from "next";
import Link from "next/link";
import { ConnectionError } from "@/components/ConnectionError";
import {
  Card,
  CardTitle,
  EmptyState,
  Mono,
  PageHeader,
  StatTile,
  cx,
  formatDateTime,
  formatRelative,
} from "@/components/ui";
import {
  getAuditSummary,
  listAuditEvents,
} from "@/lib/db/repositories/audit";
import { listRecentSessions } from "@/lib/db/repositories/decisions";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const ACTION_TONES: Readonly<Record<string, string>> = {
  "session.started": "text-approval",
  "session.completed": "text-approval",
  "tool.invoked": "text-accent-ink",
  "memory.retrieved": "text-accent",
  "memory.created": "text-approve",
  "policy.evaluated": "text-review",
  "decision.recorded": "text-ink",
  "action.executed": "text-approve",
  "approval.requested": "text-inform",
  "approval.resolved": "text-approve",
  error: "text-reject",
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ errors?: string }>;
}) {
  const params = await searchParams;
  const onlyErrors = params.errors === "1";

  try {
    const [events, summary, sessions] = await Promise.all([
      listAuditEvents({ limit: 250, onlyErrors }),
      getAuditSummary(),
      listRecentSessions(10),
    ]);

    return (
      <>
        <PageHeader
          title="Audit log"
          description="Every tool the agent invoked, every memory it retrieved, every policy it evaluated, and every action it took. Private reasoning is deliberately absent — this records what the agent did, not what it thought."
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Events" value={summary.total_events} />
          <StatTile
            label="Tool invocations"
            value={summary.tool_invocations}
            detail="Reads and actions against CockroachDB"
          />
          <StatTile
            label="Memories written"
            value={summary.memories_created}
            detail="Each one retrievable by a future decision"
            tone="accent"
          />
          <StatTile
            label="Errors"
            value={summary.errors}
            detail={
              summary.errors === 0
                ? "No failures recorded"
                : "Recorded rather than swallowed"
            }
            tone={summary.errors > 0 ? "warn" : "neutral"}
          />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="mb-3 flex items-center gap-1.5">
              <FilterLink label="All events" href="/audit" active={!onlyErrors} />
              <FilterLink
                label="Errors only"
                href="/audit?errors=1"
                active={onlyErrors}
              />
            </div>

            {events.length === 0 ? (
              <EmptyState
                title={onlyErrors ? "No errors recorded" : "No audit events yet"}
                description="Send a request from the Agent page to generate a trace."
              />
            ) : (
              <Card padded={false}>
                <ul className="divide-y divide-line">
                  {events.map((event) => (
                    <li key={event.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-baseline gap-2">
                          <span
                            className={cx(
                              "font-mono text-xs",
                              ACTION_TONES[event.action] ?? "text-ink-muted",
                            )}
                          >
                            {event.tool_name ?? event.action}
                          </span>
                          {event.tool_name ? (
                            <span className="text-[10px] text-ink-subtle">
                              {event.action}
                            </span>
                          ) : null}
                          {event.request_reference ? (
                            <Link
                              href={`/requests/${event.request_id}`}
                              className="text-[11px] text-accent-ink hover:underline"
                            >
                              {event.request_reference}
                            </Link>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-ink-subtle">
                          {event.duration_ms > 0 ? `${event.duration_ms}ms · ` : ""}
                          {formatDateTime(event.created_at)}
                        </span>
                      </div>

                      {event.result_summary ? (
                        <p
                          className={cx(
                            "mt-1 text-xs leading-relaxed",
                            event.is_error ? "text-reject" : "text-ink-muted",
                          )}
                        >
                          {event.result_summary}
                        </p>
                      ) : null}

                      {Object.keys(event.parameters).length > 0 ? (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-[10px] text-ink-subtle transition-colors hover:text-ink-muted">
                            parameters
                          </summary>
                          <pre className="mt-1 overflow-x-auto rounded border border-line bg-canvas p-2 font-mono text-[10px] leading-relaxed text-ink-subtle">
                            {JSON.stringify(event.parameters, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <Card>
              <CardTitle hint={`${sessions.length} recent`}>Sessions</CardTitle>
              {sessions.length === 0 ? (
                <EmptyState title="No sessions yet" />
              ) : (
                <ul className="space-y-3">
                  {sessions.map((session) => (
                    <li key={session.id} className="text-xs">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-ink">
                          {session.user_name}
                        </span>
                        <span
                          className={cx(
                            "text-[10px]",
                            session.status === "failed"
                              ? "text-reject"
                              : "text-ink-subtle",
                          )}
                        >
                          {session.status}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-subtle">
                        {session.reasoning_provider}
                        {session.model ? ` · ${session.model}` : ""}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-subtle">
                        {session.request_reference ?? "no request"} ·{" "}
                        {session.latency_ms}ms ·{" "}
                        {session.input_tokens + session.output_tokens > 0
                          ? `${session.input_tokens + session.output_tokens} tokens · `
                          : ""}
                        {formatRelative(session.started_at)}
                      </p>
                      {session.error ? (
                        <p className="mt-0.5 text-[10px] text-reject">
                          {session.error}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardTitle>What is recorded</CardTitle>
              <ul className="space-y-2 text-xs leading-relaxed text-ink-muted">
                <li>
                  <Mono>tool.invoked</Mono> — the tool, its arguments, a summary
                  of what it returned, and how long it took.
                </li>
                <li>
                  <Mono>memory.retrieved</Mono> — the query and how many memories
                  cleared the similarity threshold.
                </li>
                <li>
                  <Mono>policy.evaluated</Mono> — which policies fired and the
                  verdict they produced.
                </li>
                <li>
                  <Mono>decision.recorded</Mono> — the outcome, and whether policy
                  overrode the model.
                </li>
              </ul>
              <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-subtle">
                The model&apos;s chain of thought is never returned or stored.
                Adaptive thinking runs with output omitted, so what you see here
                is the complete record of what the agent actually did.
              </p>
            </Card>
          </div>
        </div>
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Audit log" />
        <ConnectionError error={error} />
      </>
    );
  }
}

function FilterLink({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent-dim bg-accent-dim/40 text-accent-ink"
          : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
}

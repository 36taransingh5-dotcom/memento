import Link from "next/link";
import { ConnectionError } from "@/components/ConnectionError";
import {
  Card,
  CardTitle,
  DecisionBadge,
  EmptyState,
  Mono,
  PageHeader,
  StatTile,
  StatusPill,
  Tag,
  formatRelative,
  formatUsd,
} from "@/components/ui";
import { health } from "@/lib/db/client";
import { getAuditSummary } from "@/lib/db/repositories/audit";
import {
  countDecisionsByType,
  listPendingApprovals,
  listRecentDecisions,
  listRecentSessions,
} from "@/lib/db/repositories/decisions";
import { getMemoryStats, listMemories } from "@/lib/db/repositories/memories";
import { listTeams } from "@/lib/db/repositories/organization";
import { listRequests } from "@/lib/db/repositories/requests";
import { listResources } from "@/lib/db/repositories/resources";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  try {
    return await Overview();
  } catch (error) {
    return (
      <>
        <PageHeader
          title="Overview"
          description="Operational state of Northstar Labs."
        />
        <ConnectionError error={error} />
      </>
    );
  }
}

async function Overview() {
  const [
    requests,
    decisions,
    decisionCounts,
    approvals,
    memoryStats,
    recentMemories,
    resources,
    sessions,
    audit,
    teams,
    db,
  ] = await Promise.all([
    listRequests({ limit: 100 }),
    listRecentDecisions(6),
    countDecisionsByType(),
    listPendingApprovals(),
    getMemoryStats(),
    listMemories({ limit: 5 }),
    listResources(),
    listRecentSessions(5),
    getAuditSummary(),
    listTeams(),
    health(),
  ]);

  const openRequests = requests.filter(
    (r) => !["approved", "rejected", "fulfilled", "withdrawn"].includes(r.status),
  );

  const gpus = resources.filter((r) => r.kind === "gpu");
  const idleGpus = gpus.filter((r) => r.status === "idle");
  const idleSpend = idleGpus.reduce((sum, r) => sum + r.monthly_cost_usd, 0);

  const reuseDecisions = decisionCounts.find(
    (d) => d.decision === "REQUEST_INFORMATION",
  );
  const totalDecisions = decisionCounts.reduce((sum, d) => sum + d.count, 0);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Operational state of Northstar Labs, and what Memento has been remembering."
        actions={
          <Link
            href="/agent"
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-opacity hover:opacity-90"
          >
            Open agent
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open requests"
          value={openRequests.length}
          detail={`${requests.length} total across ${teams.length} teams`}
        />
        <StatTile
          label="Pending approvals"
          value={approvals.length}
          detail={
            approvals.length === 0
              ? "Nothing waiting on a human"
              : "Waiting on a human decision"
          }
          tone={approvals.length > 0 ? "warn" : "neutral"}
        />
        <StatTile
          label="Memories stored"
          value={memoryStats.total}
          detail={`${memoryStats.embedded} embedded · ${memoryStats.created_last_7_days} in the last 7 days`}
          tone="accent"
        />
        <StatTile
          label="Idle GPU spend"
          value={formatUsd(idleSpend)}
          detail={`${idleGpus.length} of ${gpus.length} GPUs idle right now`}
          tone={idleGpus.length > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint={`${decisions.length} most recent`}>
            Recent decisions
          </CardTitle>
          {decisions.length === 0 ? (
            <EmptyState
              title="No decisions yet"
              description="Send a request from the Agent page to see the decision trace."
            />
          ) : (
            <ul className="divide-y divide-line">
              {decisions.map((decision) => (
                <li key={decision.id} className="py-3 first:pt-0 last:pb-0">
                  <Link
                    href={`/requests/${decision.request_id}`}
                    className="group block"
                  >
                    <div className="flex flex-wrap items-center gap-2.5">
                      <DecisionBadge decision={decision.decision} />
                      <span className="text-sm font-medium text-ink group-hover:text-accent-ink">
                        {decision.request_title}
                      </span>
                      <Mono>{decision.request_reference}</Mono>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                      {decision.rationale}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-subtle">
                      <span>{decision.requester_name}</span>
                      <span aria-hidden>·</span>
                      <span>{decision.team_name}</span>
                      <span aria-hidden>·</span>
                      <span>{formatRelative(decision.created_at)}</span>
                      {decision.policy_overrode_model ? (
                        <Tag tone="hard">policy override</Tag>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardTitle>Decision mix</CardTitle>
            {totalDecisions === 0 ? (
              <EmptyState title="No decisions yet" />
            ) : (
              <ul className="space-y-2.5">
                {decisionCounts.map((row) => (
                  <li key={row.decision} className="flex items-center gap-3">
                    <div className="w-full">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <DecisionBadge decision={row.decision} />
                        <span className="tabular-nums text-ink-muted">
                          {row.count}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-raised">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{
                            width: `${Math.round((row.count / totalDecisions) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {reuseDecisions ? (
              <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-subtle">
                {reuseDecisions.count} request
                {reuseDecisions.count === 1 ? "" : "s"} were answered by pointing
                at capacity the organization already owned, rather than
                provisioning something new.
              </p>
            ) : null}
          </Card>

          <Card>
            <CardTitle>Infrastructure</CardTitle>
            <dl className="space-y-2.5 text-xs">
              <Row
                label="CockroachDB"
                value={db.reachable ? (db.database ?? "connected") : "unreachable"}
                tone={db.reachable ? "ok" : "bad"}
              />
              <Row
                label="Vector index"
                value={db.vectorIndexPresent ? "C-SPANN active" : "exact scan"}
                tone={db.vectorIndexPresent ? "ok" : "warn"}
              />
              <Row
                label="Embedded memories"
                value={`${db.embeddedMemoryCount} / ${db.memoryCount}`}
                tone={
                  db.embeddedMemoryCount === db.memoryCount ? "ok" : "warn"
                }
              />
              <Row
                label="Tool invocations"
                value={String(audit.tool_invocations)}
                tone="neutral"
              />
              <Row
                label="Audit events"
                value={String(audit.total_events)}
                tone={audit.errors > 0 ? "warn" : "neutral"}
              />
            </dl>
            {db.version ? (
              <p className="mt-3 border-t border-line pt-3 font-mono text-[10px] leading-relaxed text-ink-subtle">
                {db.version.split(" (")[0]}
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle hint="newest first">Memory activity</CardTitle>
          {recentMemories.length === 0 ? (
            <EmptyState title="No memories yet" />
          ) : (
            <ul className="space-y-3">
              {recentMemories.map((memory) => (
                <li key={memory.id}>
                  <Link href={`/memory/${memory.id}`} className="group block">
                    <div className="flex items-start gap-2">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                      <div className="min-w-0">
                        <p className="text-xs font-medium leading-snug text-ink group-hover:text-accent-ink">
                          {memory.summary}
                        </p>
                        <p className="mt-0.5 text-[11px] text-ink-subtle">
                          {memory.memory_type.replace(/_/g, " ")} ·{" "}
                          {formatRelative(memory.occurred_at)}
                        </p>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/memory"
            className="mt-4 inline-block border-t border-line pt-3 text-xs text-accent-ink hover:underline"
          >
            All memory →
          </Link>
        </Card>

        <Card>
          <CardTitle hint={`${approvals.length} waiting`}>
            Pending approvals
          </CardTitle>
          {approvals.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              description="Every request has either been decided or is still with the agent."
            />
          ) : (
            <ul className="space-y-3">
              {approvals.map((approval) => (
                <li key={approval.id}>
                  <Link
                    href={`/requests/${approval.request_id}`}
                    className="group block"
                  >
                    <p className="text-xs font-medium leading-snug text-ink group-hover:text-accent-ink">
                      {approval.request_title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-subtle">
                      Needs {approval.required_role} · {approval.team_name} ·{" "}
                      {formatRelative(approval.created_at)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle hint={`${sessions.length} most recent`}>
            Agent activity
          </CardTitle>
          {sessions.length === 0 ? (
            <EmptyState title="No sessions yet" />
          ) : (
            <ul className="space-y-3">
              {sessions.map((session) => (
                <li key={session.id} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink">
                      {session.user_name}
                    </span>
                    <Tag
                      tone={
                        session.reasoning_provider === "bedrock"
                          ? "accent"
                          : "soft"
                      }
                    >
                      {session.reasoning_provider}
                    </Tag>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-subtle">
                    {session.request_reference ?? "no request"} ·{" "}
                    {session.latency_ms}ms · {formatRelative(session.started_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle hint={`${openRequests.length} open`}>
          Requests needing attention
        </CardTitle>
        {openRequests.length === 0 ? (
          <EmptyState title="Everything is resolved" />
        ) : (
          <ul className="divide-y divide-line">
            {openRequests.slice(0, 6).map((request) => (
              <li key={request.id} className="py-2.5 first:pt-0 last:pb-0">
                <Link
                  href={`/requests/${request.id}`}
                  className="group flex flex-wrap items-center justify-between gap-2"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Mono>{request.reference}</Mono>
                    <span className="truncate text-sm text-ink group-hover:text-accent-ink">
                      {request.title}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-[11px] text-ink-subtle">
                      {request.requester_name}
                    </span>
                    <StatusPill status={request.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}) {
  const toneClass = {
    ok: "text-approve",
    warn: "text-inform",
    bad: "text-reject",
    neutral: "text-ink-muted",
  }[tone];

  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className={`font-medium ${toneClass}`}>{value}</dd>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApprovalActions } from "@/components/ApprovalActions";
import { ConnectionError } from "@/components/ConnectionError";
import {
  Card,
  CardTitle,
  DecisionBadge,
  EmptyState,
  Mono,
  PageHeader,
  StatusPill,
  Tag,
  cx,
  formatDateTime,
  formatRelative,
  formatUsd,
} from "@/components/ui";
import { listAuditEvents } from "@/lib/db/repositories/audit";
import {
  listDecisionsForRequest,
  listPendingApprovals,
} from "@/lib/db/repositories/decisions";
import { listApprovers } from "@/lib/db/repositories/organization";
import {
  getRequestById,
  listRequestEvents,
} from "@/lib/db/repositories/requests";
import { listMemories } from "@/lib/db/repositories/memories";

export const metadata: Metadata = { title: "Request" };
export const dynamic = "force-dynamic";

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  try {
    const request = await getRequestById(id);
    if (!request) notFound();

    const [decisions, timeline, audit, approvals, memories] = await Promise.all([
      listDecisionsForRequest(request.id),
      listRequestEvents(request.id),
      listAuditEvents({ requestId: request.id, limit: 60 }),
      listPendingApprovals(),
      listMemories({ limit: 200 }),
    ]);

    const pendingApproval = approvals.find((a) => a.request_id === request.id);
    const approvers = pendingApproval
      ? await listApprovers(request.team_id, pendingApproval.required_role)
      : [];

    const relatedMemories = memories.filter(
      (m) => m.source_request_id === request.id,
    );
    const latest = decisions[0];

    return (
      <>
        <PageHeader
          title={request.title}
          description={`${request.reference} · raised by ${request.requester_name} (${request.team_name}) ${formatRelative(request.created_at)}`}
          actions={
            <Link
              href="/requests"
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              ← All requests
            </Link>
          }
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardTitle hint="verbatim">The request</CardTitle>
              <p className="text-[15px] leading-relaxed text-ink">
                &ldquo;{request.body}&rdquo;
              </p>
            </Card>

            {latest ? (
              <Card>
                <CardTitle
                  hint={
                    decisions.length > 1
                      ? `${decisions.length} decisions`
                      : undefined
                  }
                >
                  Decision
                </CardTitle>

                <div className="flex flex-wrap items-center gap-2">
                  <DecisionBadge decision={latest.decision} size="lg" />
                  <Tag
                    tone={
                      latest.reasoning_provider === "bedrock" ? "accent" : "soft"
                    }
                  >
                    {latest.reasoning_provider === "bedrock"
                      ? (latest.model ?? "bedrock")
                      : "deterministic"}
                  </Tag>
                  <span className="text-[11px] text-ink-subtle">
                    confidence {latest.confidence} ·{" "}
                    {formatDateTime(latest.created_at)}
                  </span>
                </div>

                <p className="mt-4 text-[15px] leading-relaxed text-ink">
                  {latest.rationale}
                </p>

                {latest.next_action ? (
                  <div className="mt-4 rounded-lg border border-line bg-canvas px-4 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                      Next action
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                      {latest.next_action}
                    </p>
                  </div>
                ) : null}

                {latest.policy_overrode_model ? (
                  <div className="mt-4 rounded-lg border border-reject-bg px-4 py-3 text-xs">
                    <p className="font-medium text-reject">
                      Deterministic policy overrode the model
                    </p>
                    <p className="mt-1 leading-relaxed text-ink-muted">
                      The model proposed{" "}
                      <span className="font-mono">
                        {latest.model_proposed_decision}
                      </span>
                      ; a binding policy required{" "}
                      <span className="font-mono">{latest.decision}</span>.
                    </p>
                  </div>
                ) : null}

                {latest.evidence.length > 0 ? (
                  <div className="mt-5 border-t border-line pt-4">
                    <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                      Evidence
                    </p>
                    <ul className="space-y-2.5">
                      {latest.evidence.map((item, index) => (
                        <li
                          key={`${item.label}-${index}`}
                          className="flex gap-2.5"
                        >
                          <span
                            className={cx(
                              "mt-1.5 size-1.5 shrink-0 rounded-full",
                              item.source === "policy" ? "bg-review" : "bg-accent",
                            )}
                          />
                          <div>
                            <p className="text-xs font-medium text-ink">
                              {item.label}
                            </p>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                              {item.detail}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {latest.policies_triggered.length > 0 ? (
                  <div className="mt-5 border-t border-line pt-4">
                    <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                      Policies triggered
                    </p>
                    <ul className="space-y-2.5">
                      {latest.policies_triggered.map((policy) => (
                        <li key={policy.key}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-ink">
                              {policy.name}
                            </span>
                            <Tag
                              tone={policy.severity === "hard" ? "hard" : "soft"}
                            >
                              {policy.severity === "hard"
                                ? "binding"
                                : "advisory"}
                            </Tag>
                          </div>
                          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                            {policy.explanation}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {latest.memories_used.length > 0 ? (
                  <div className="mt-5 border-t border-line pt-4">
                    <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                      Memory retrieved at decision time
                    </p>
                    <ul className="space-y-2.5">
                      {latest.memories_used.map((memory) => (
                        <li key={memory.id}>
                          <Link
                            href={`/memory/${memory.id}`}
                            className="group flex items-start justify-between gap-3"
                          >
                            <span className="text-xs leading-snug text-ink-muted group-hover:text-accent-ink">
                              {memory.summary}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-subtle">
                              {memory.similarity.toFixed(3)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Card>
            ) : (
              <Card>
                <CardTitle>Decision</CardTitle>
                <EmptyState title="Not yet decided" />
              </Card>
            )}

            <Card>
              <CardTitle hint={`${timeline.length} events`}>Timeline</CardTitle>
              <ol className="space-y-3">
                {timeline.map((event) => (
                  <li key={event.id} className="flex gap-3">
                    <span
                      className={cx(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        event.actor_type === "agent"
                          ? "bg-accent"
                          : event.actor_type === "user"
                            ? "bg-approval"
                            : "bg-line-strong",
                      )}
                    />
                    <div className="min-w-0">
                      <p className="text-xs leading-relaxed text-ink-muted">
                        {event.summary}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-subtle">
                        {event.event_type.replace(/_/g, " ")} · {event.actor_type}{" "}
                        · {formatDateTime(event.created_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardTitle>Details</CardTitle>
              <dl className="space-y-3 text-xs">
                <Field label="Status" value={<StatusPill status={request.status} />} />
                <Field label="Reference" value={<Mono>{request.reference}</Mono>} />
                <Field
                  label="Type"
                  value={request.request_type.replace(/_/g, " ")}
                />
                <Field
                  label="Resource"
                  value={request.resource_kind?.replace(/_/g, " ") ?? "—"}
                />
                <Field label="Quantity" value={String(request.quantity)} />
                <Field
                  label="Est. cost"
                  value={
                    request.estimated_monthly_cost_usd === null
                      ? "—"
                      : `${formatUsd(request.estimated_monthly_cost_usd)}/mo`
                  }
                />
                <Field label="Vendor" value={request.vendor ?? "—"} />
                <Field label="Environment" value={request.environment ?? "—"} />
                <Field
                  label="Duration"
                  value={
                    request.duration_days ? `${request.duration_days} days` : "—"
                  }
                />
              </dl>
            </Card>

            {pendingApproval ? (
              <Card className="border-inform-bg">
                <CardTitle>Awaiting human decision</CardTitle>
                <p className="mb-4 text-xs leading-relaxed text-ink-muted">
                  {pendingApproval.reason}
                </p>
                <ApprovalActions
                  approvalId={pendingApproval.id}
                  requiredRole={pendingApproval.required_role}
                  approvers={approvers}
                />
              </Card>
            ) : null}

            {relatedMemories.length > 0 ? (
              <Card>
                <CardTitle hint={`${relatedMemories.length}`}>
                  Memory this created
                </CardTitle>
                <ul className="space-y-2.5">
                  {relatedMemories.map((memory) => (
                    <li key={memory.id}>
                      <Link
                        href={`/memory/${memory.id}`}
                        className="group block text-xs"
                      >
                        <span className="font-medium leading-snug text-ink group-hover:text-accent-ink">
                          {memory.summary}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-ink-subtle">
                          {memory.memory_type.replace(/_/g, " ")} ·{" "}
                          {formatRelative(memory.created_at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {audit.length > 0 ? (
              <Card>
                <CardTitle hint={`${audit.length} events`}>Audit</CardTitle>
                <ul className="space-y-1.5">
                  {audit.slice(0, 14).map((event) => (
                    <li key={event.id} className="text-[11px]">
                      <span
                        className={cx(
                          "font-mono",
                          event.is_error ? "text-reject" : "text-accent-ink",
                        )}
                      >
                        {event.tool_name ?? event.action}
                      </span>
                      <span className="ml-1.5 text-ink-subtle">
                        {event.result_summary}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/audit"
                  className="mt-3 inline-block border-t border-line pt-2.5 text-xs text-accent-ink hover:underline"
                >
                  Full audit log →
                </Link>
              </Card>
            ) : null}
          </div>
        </div>
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Request" />
        <ConnectionError error={error} />
      </>
    );
  }
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-subtle">{label}</dt>
      <dd className="text-right capitalize text-ink-muted">{value}</dd>
    </div>
  );
}

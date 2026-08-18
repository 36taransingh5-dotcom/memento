import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectionError } from "@/components/ConnectionError";
import {
  Card,
  CardTitle,
  DecisionBadge,
  EmptyState,
  Mono,
  PageHeader,
  Tag,
  formatDateTime,
  formatRelative,
} from "@/components/ui";
import { getMemoryById } from "@/lib/db/repositories/memories";
import { getDecisionById } from "@/lib/db/repositories/decisions";
import {
  getRequestById,
  listRequestEvents,
} from "@/lib/db/repositories/requests";

export const metadata: Metadata = { title: "Memory detail" };
export const dynamic = "force-dynamic";

/**
 * A memory and the real event that produced it.
 *
 * Every semantic memory carries foreign keys back to its source, which is what
 * separates this from a vector store full of free-floating strings: you can
 * always walk from "the agent recalled this" to "here is the request, the
 * decision, and the timeline it came from".
 */
export default async function MemoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  try {
    const memory = await getMemoryById(id);
    if (!memory) notFound();

    const [sourceRequest, sourceDecision, timeline] = await Promise.all([
      memory.source_request_id ? getRequestById(memory.source_request_id) : null,
      memory.source_decision_id
        ? getDecisionById(memory.source_decision_id)
        : null,
      memory.source_request_id
        ? listRequestEvents(memory.source_request_id)
        : Promise.resolve([]),
    ]);

    return (
      <>
        <PageHeader
          title={memory.summary}
          description={`${memory.memory_type.replace(/_/g, " ")} recorded ${formatRelative(memory.occurred_at)}`}
          actions={
            <Link
              href="/memory"
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              ← All memory
            </Link>
          }
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardTitle>Memory</CardTitle>
              <p className="text-[15px] leading-relaxed text-ink">
                {memory.content}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-[11px] text-ink-subtle">
                <Tag tone="accent">{memory.memory_type.replace(/_/g, " ")}</Tag>
                <span>importance {memory.importance}/5</span>
                <span aria-hidden>·</span>
                <span>occurred {formatDateTime(memory.occurred_at)}</span>
                <span aria-hidden>·</span>
                <span>written {formatDateTime(memory.created_at)}</span>
                {memory.expires_at ? (
                  <Tag tone="soft">
                    goes stale {formatRelative(memory.expires_at)}
                  </Tag>
                ) : null}
                {memory.superseded_by ? (
                  <Tag tone="hard">superseded</Tag>
                ) : null}
              </div>
            </Card>

            {sourceRequest ? (
              <Card>
                <CardTitle hint="the event this memory came from">
                  Source request
                </CardTitle>
                <Link
                  href={`/requests/${sourceRequest.id}`}
                  className="group block"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Mono>{sourceRequest.reference}</Mono>
                    <span className="text-sm font-medium text-ink group-hover:text-accent-ink">
                      {sourceRequest.title}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                    &ldquo;{sourceRequest.body}&rdquo;
                  </p>
                  <p className="mt-2 text-[11px] text-ink-subtle">
                    {sourceRequest.requester_name} · {sourceRequest.team_name} ·{" "}
                    {formatDateTime(sourceRequest.created_at)}
                  </p>
                </Link>

                {sourceDecision ? (
                  <div className="mt-4 rounded-lg border border-line bg-canvas p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <DecisionBadge decision={sourceDecision.decision} />
                      <span className="text-[11px] text-ink-subtle">
                        {formatDateTime(sourceDecision.created_at)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                      {sourceDecision.rationale}
                    </p>
                  </div>
                ) : null}
              </Card>
            ) : (
              <Card>
                <CardTitle>Source</CardTitle>
                <EmptyState
                  title="No originating request"
                  description="This memory records organizational context rather than a single decision — a standing preference, a constraint, or a seeded fact."
                />
              </Card>
            )}

            {timeline.length > 0 ? (
              <Card>
                <CardTitle hint={`${timeline.length} events`}>
                  Source timeline
                </CardTitle>
                <ol className="space-y-3">
                  {timeline.map((event) => (
                    <li key={event.id} className="flex gap-3">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-line-strong" />
                      <div className="min-w-0">
                        <p className="text-xs leading-relaxed text-ink-muted">
                          {event.summary}
                        </p>
                        <p className="mt-0.5 text-[10px] text-ink-subtle">
                          {event.event_type.replace(/_/g, " ")} ·{" "}
                          {event.actor_type} ·{" "}
                          {formatDateTime(event.created_at)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            ) : null}
          </div>

          <div className="space-y-4">
            <Card>
              <CardTitle>Subjects</CardTitle>
              <dl className="space-y-3 text-xs">
                <Field label="Team" value={memory.team_name} />
                <Field label="Person" value={memory.user_name} />
                <Field label="Resource" value={memory.resource_name} />
                <Field label="Source kind" value={memory.source_kind} />
              </dl>
            </Card>

            <Card>
              <CardTitle>Embedding</CardTitle>
              <dl className="space-y-3 text-xs">
                <Field
                  label="Model"
                  value={memory.embedding_model ?? "not embedded"}
                />
                <Field label="Storage" value="CockroachDB VECTOR(1024)" />
                <Field label="Metric" value="cosine distance (<=>)" />
              </dl>
              {memory.embedding_model?.startsWith("local-") ? (
                <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-inform">
                  Embedded with the local lexical fallback, not Amazon Bedrock.
                  Retrieval will match shared vocabulary rather than meaning.
                </p>
              ) : null}
            </Card>

            {Object.keys(memory.metadata).length > 0 ? (
              <Card>
                <CardTitle>Metadata</CardTitle>
                <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-ink-muted">
                  {JSON.stringify(memory.metadata, null, 2)}
                </pre>
              </Card>
            ) : null}
          </div>
        </div>
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Memory detail" />
        <ConnectionError error={error} />
      </>
    );
  }
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-subtle">{label}</dt>
      <dd className="text-right text-ink-muted">{value ?? "—"}</dd>
    </div>
  );
}

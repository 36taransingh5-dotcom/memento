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
  Tag,
  cx,
  formatDate,
  formatRelative,
} from "@/components/ui";
import { health } from "@/lib/db/client";
import { getMemoryStats, listMemories } from "@/lib/db/repositories/memories";
import type { MemoryType } from "@/lib/db/types";

export const metadata: Metadata = { title: "Memory" };
export const dynamic = "force-dynamic";

const TYPE_TONES: Readonly<Record<MemoryType, string>> = {
  decision: "text-approval",
  outcome: "text-approve",
  policy_exception: "text-review",
  preference: "text-accent-ink",
  event: "text-ink-muted",
  expiration: "text-inform",
  constraint: "text-reject",
};

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const params = await searchParams;
  const filter = params.type as MemoryType | undefined;

  try {
    const [memories, stats, db] = await Promise.all([
      listMemories({ memoryType: filter, limit: 200 }),
      getMemoryStats(),
      health(),
    ]);

    return (
      <>
        <PageHeader
          title="Memory"
          description="Everything Memento has learned about Northstar Labs. Each memory is embedded into a CockroachDB VECTOR column and retrieved by cosine similarity when a new request arrives."
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Memories"
            value={stats.total}
            detail={`${stats.embedded} carry a vector and are retrievable`}
            tone="accent"
          />
          <StatTile
            label="New this week"
            value={stats.created_last_7_days}
            detail="Written by the agent as decisions were made"
          />
          <StatTile
            label="Memory types"
            value={stats.by_type.length}
            detail={stats.by_type
              .slice(0, 3)
              .map((t) => t.memory_type.replace(/_/g, " "))
              .join(", ")}
          />
          <StatTile
            label="Retrieval"
            value={db.vectorIndexPresent ? "C-SPANN" : "exact scan"}
            detail={
              db.vectorIndexPresent
                ? "Distributed vector index serving nearest-neighbour search"
                : "Vector index unavailable — cosine distance computed per row"
            }
            tone={db.vectorIndexPresent ? "accent" : "warn"}
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-1.5">
          <FilterLink label="All" href="/memory" active={!filter} count={stats.total} />
          {stats.by_type.map((row) => (
            <FilterLink
              key={row.memory_type}
              label={row.memory_type.replace(/_/g, " ")}
              href={`/memory?type=${row.memory_type}`}
              active={filter === row.memory_type}
              count={row.count}
            />
          ))}
        </div>

        <div className="mt-4">
          {memories.length === 0 ? (
            <EmptyState
              title="No memories of this kind yet"
              description="Memories are written whenever the agent decides something, and can also be seeded."
            />
          ) : (
            <ul className="space-y-3">
              {memories.map((memory) => (
                <li key={memory.id}>
                  <Link
                    href={`/memory/${memory.id}`}
                    className="group block rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong hover:bg-surface-hover"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="text-sm font-medium leading-snug text-ink group-hover:text-accent-ink">
                        {memory.summary}
                      </h3>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={cx(
                            "text-[11px] font-medium",
                            TYPE_TONES[memory.memory_type],
                          )}
                        >
                          {memory.memory_type.replace(/_/g, " ")}
                        </span>
                        <ImportanceDots value={memory.importance} />
                      </div>
                    </div>

                    <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                      {memory.content}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[11px] text-ink-subtle">
                      <span>{formatDate(memory.occurred_at)}</span>
                      <span aria-hidden>·</span>
                      <span>{formatRelative(memory.occurred_at)}</span>

                      {memory.team_name ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{memory.team_name}</span>
                        </>
                      ) : null}
                      {memory.user_name ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{memory.user_name}</span>
                        </>
                      ) : null}
                      {memory.resource_name ? (
                        <>
                          <span aria-hidden>·</span>
                          <Mono>{memory.resource_name}</Mono>
                        </>
                      ) : null}
                      {memory.source_request_reference ? (
                        <Tag tone="accent">
                          {memory.source_request_reference}
                        </Tag>
                      ) : null}
                      {memory.expires_at ? (
                        <Tag tone="soft">
                          expires {formatRelative(memory.expires_at)}
                        </Tag>
                      ) : null}
                      {!memory.embedding_model ? (
                        <Tag tone="hard">not embedded</Tag>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Card className="mt-6">
          <CardTitle>How retrieval works</CardTitle>
          <p className="text-sm leading-relaxed text-ink-muted">
            When a request arrives, its text is embedded with the same model that
            embedded these memories. CockroachDB then orders every memory by
            cosine distance from that query vector and returns the closest few,
            filtered to those that have not expired or been superseded. The
            similarity score of each retrieved memory is recorded on the decision,
            so you can always see how relevant the agent judged it to be.
          </p>
        </Card>
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Memory" />
        <ConnectionError error={error} />
      </>
    );
  }
}

function FilterLink({
  label,
  href,
  active,
  count,
}: {
  label: string;
  href: string;
  active: boolean;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent-dim bg-accent-dim/40 text-accent-ink"
          : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
      )}
    >
      {label}
      <span className="tabular-nums text-[10px] opacity-70">{count}</span>
    </Link>
  );
}

/** Importance 1–5, shown compactly rather than as a number nobody calibrates. */
function ImportanceDots({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-0.5" title={`Importance ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((step) => (
        <span
          key={step}
          className={cx(
            "size-1 rounded-full",
            step <= value ? "bg-accent" : "bg-line-strong",
          )}
        />
      ))}
    </span>
  );
}

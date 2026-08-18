import type { Metadata } from "next";
import Link from "next/link";
import { ConnectionError } from "@/components/ConnectionError";
import {
  DecisionBadge,
  EmptyState,
  Mono,
  PageHeader,
  StatusPill,
  Table,
  Td,
  Th,
  cx,
  formatRelative,
  formatUsd,
} from "@/components/ui";
import {
  countRequestsByStatus,
  listRequests,
} from "@/lib/db/repositories/requests";
import type { RequestStatus } from "@/lib/db/types";

export const metadata: Metadata = { title: "Requests" };
export const dynamic = "force-dynamic";

const STATUS_ORDER: readonly RequestStatus[] = [
  "pending",
  "needs_information",
  "under_review",
  "approved",
  "rejected",
  "fulfilled",
  "withdrawn",
];

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = STATUS_ORDER.includes(params.status as RequestStatus)
    ? (params.status as RequestStatus)
    : undefined;

  try {
    const [requests, counts] = await Promise.all([
      listRequests({ status, limit: 200 }),
      countRequestsByStatus(),
    ]);

    const total = counts.reduce((sum, c) => sum + c.count, 0);

    return (
      <>
        <PageHeader
          title="Requests"
          description="Every operational request Northstar Labs has raised, and what Memento decided about it."
        />

        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <FilterLink label="All" href="/requests" active={!status} count={total} />
          {STATUS_ORDER.filter((s) =>
            counts.some((c) => c.status === s),
          ).map((s) => (
            <FilterLink
              key={s}
              label={s.replace(/_/g, " ")}
              href={`/requests?status=${s}`}
              active={status === s}
              count={counts.find((c) => c.status === s)?.count ?? 0}
            />
          ))}
        </div>

        {requests.length === 0 ? (
          <EmptyState
            title="No requests with this status"
            description="Send one from the Agent page."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Requester</Th>
                <Th>Decision</Th>
                <Th>Status</Th>
                <Th align="right">Est. cost</Th>
                <Th align="right">Raised</Th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr
                  key={request.id}
                  className="transition-colors hover:bg-surface-hover"
                >
                  <Td>
                    <Link href={`/requests/${request.id}`} className="group block">
                      <span className="flex items-center gap-2">
                        <Mono>{request.reference}</Mono>
                      </span>
                      <span className="mt-0.5 block text-sm font-medium text-ink group-hover:text-accent-ink">
                        {request.title}
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    <span className="block text-ink">{request.requester_name}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-subtle">
                      {request.team_name}
                    </span>
                  </Td>
                  <Td>
                    {request.latest_decision ? (
                      <DecisionBadge decision={request.latest_decision} />
                    ) : (
                      <span className="text-xs text-ink-subtle">undecided</span>
                    )}
                  </Td>
                  <Td>
                    <StatusPill status={request.status} />
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {formatUsd(request.estimated_monthly_cost_usd)}
                    {request.estimated_monthly_cost_usd !== null ? (
                      <span className="text-[10px] text-ink-subtle">/mo</span>
                    ) : null}
                  </Td>
                  <Td align="right" className="whitespace-nowrap text-[11px]">
                    {formatRelative(request.created_at)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Requests" />
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
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
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

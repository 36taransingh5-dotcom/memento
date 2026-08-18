import type { Metadata } from "next";
import { ConnectionError } from "@/components/ConnectionError";
import {
  Card,
  CardTitle,
  EmptyState,
  Mono,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
  Tag,
  cx,
  formatRelative,
  formatUsd,
} from "@/components/ui";
import { listTeams } from "@/lib/db/repositories/organization";
import {
  listAllocationsForResource,
  listResources,
} from "@/lib/db/repositories/resources";
import type { ResourceKind, ResourceStatus } from "@/lib/db/types";

export const metadata: Metadata = { title: "Resources" };
export const dynamic = "force-dynamic";

const KIND_LABELS: Readonly<Record<ResourceKind, string>> = {
  gpu: "GPUs",
  cloud_instance: "Cloud instances",
  saas_license: "SaaS licenses",
  production_service: "Production services",
};

const STATUS_TONES: Readonly<Record<ResourceStatus, string>> = {
  in_use: "text-approve",
  idle: "text-inform",
  available: "text-accent-ink",
  maintenance: "text-review",
  retired: "text-ink-subtle",
};

export default async function ResourcesPage() {
  try {
    const [resources, teams] = await Promise.all([listResources(), listTeams()]);

    // Allocation history for whatever is currently idle — the reuse candidates
    // are the ones an operator actually wants the story behind.
    const idle = resources.filter((r) => r.status === "idle");
    const histories = await Promise.all(
      idle.slice(0, 4).map(async (resource) => ({
        resource,
        allocations: await listAllocationsForResource(resource.id),
      })),
    );

    const totalMonthly = resources
      .filter((r) => r.status !== "retired")
      .reduce((sum, r) => sum + r.monthly_cost_usd, 0);
    const idleMonthly = idle.reduce((sum, r) => sum + r.monthly_cost_usd, 0);
    const expiring = resources.filter(
      (r) =>
        r.allocation_expires_at &&
        new Date(r.allocation_expires_at).getTime() - Date.now() <
          14 * 24 * 60 * 60 * 1000,
    );

    const byKind = new Map<ResourceKind, typeof resources>();
    for (const resource of resources) {
      const bucket = byKind.get(resource.kind) ?? [];
      bucket.push(resource);
      byKind.set(resource.kind, bucket);
    }

    return (
      <>
        <PageHeader
          title="Resources"
          description="What Northstar Labs owns, who holds it, and what is sitting idle. This is the structured half of Memento's memory."
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Monthly spend"
            value={formatUsd(totalMonthly)}
            detail={`${resources.length} resources across ${teams.length} teams`}
          />
          <StatTile
            label="Idle spend"
            value={formatUsd(idleMonthly)}
            detail={`${idle.length} resources allocated but unused`}
            tone={idle.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Returning soon"
            value={expiring.length}
            detail="Temporary allocations expiring within 14 days"
            tone={expiring.length > 0 ? "accent" : "neutral"}
          />
          <StatTile
            label="Reusable now"
            value={
              resources.filter(
                (r) => r.status === "idle" || r.status === "available",
              ).length
            }
            detail="Capacity available without provisioning anything"
            tone="accent"
          />
        </div>

        <div className="mt-6 space-y-6">
          {[...byKind.entries()].map(([kind, items]) => (
            <div key={kind}>
              <h2 className="mb-3 text-[13px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                {KIND_LABELS[kind]}
                <span className="ml-2 text-ink-subtle/70">{items.length}</span>
              </h2>
              <Table>
                <thead>
                  <tr>
                    <Th>Resource</Th>
                    <Th>Owner</Th>
                    <Th>Status</Th>
                    <Th>Held by</Th>
                    <Th align="right">Utilization</Th>
                    <Th align="right">Cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((resource) => (
                    <tr
                      key={resource.id}
                      className="transition-colors hover:bg-surface-hover"
                    >
                      <Td>
                        <span className="block text-sm font-medium text-ink">
                          {resource.name}
                        </span>
                        <Mono>{resource.key}</Mono>
                        {resource.vendor ? (
                          <span className="ml-2 text-[11px] text-ink-subtle">
                            {resource.vendor}
                          </span>
                        ) : null}
                      </Td>
                      <Td>{resource.owner_team_name ?? "shared pool"}</Td>
                      <Td>
                        <span
                          className={cx(
                            "inline-flex items-center gap-1.5 text-xs font-medium",
                            STATUS_TONES[resource.status],
                          )}
                        >
                          <span className="size-1.5 rounded-full bg-current" />
                          {resource.status.replace(/_/g, " ")}
                        </span>
                      </Td>
                      <Td>
                        {resource.allocation_holder ? (
                          <>
                            <span className="block text-ink">
                              {resource.allocation_holder}
                            </span>
                            {resource.allocation_expires_at ? (
                              <Tag tone="accent">
                                frees up{" "}
                                {formatRelative(resource.allocation_expires_at)}
                              </Tag>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        <span className="inline-flex items-center gap-2">
                          <span className="h-1 w-12 overflow-hidden rounded-full bg-surface-raised">
                            <span
                              className={cx(
                                "block h-full rounded-full",
                                resource.utilization_percent === 0
                                  ? "bg-inform"
                                  : "bg-accent",
                              )}
                              style={{
                                width: `${resource.utilization_percent}%`,
                              }}
                            />
                          </span>
                          {resource.utilization_percent}%
                        </span>
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {formatUsd(resource.monthly_cost_usd)}
                        <span className="text-[10px] text-ink-subtle">/mo</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ))}
        </div>

        <Card className="mt-6">
          <CardTitle hint="reuse candidates">Allocation history</CardTitle>
          {histories.length === 0 ? (
            <EmptyState
              title="Nothing is idle"
              description="Every resource is either in use or retired."
            />
          ) : (
            <div className="grid gap-5 md:grid-cols-2">
              {histories.map(({ resource, allocations }) => (
                <div key={resource.id}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-ink">
                      {resource.name}
                    </span>
                    <Mono>{resource.key}</Mono>
                  </div>
                  {allocations.length === 0 ? (
                    <p className="mt-1.5 text-xs text-ink-subtle">
                      Never allocated — available since it was provisioned.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {allocations.map((allocation) => (
                        <li key={allocation.id} className="text-[11px]">
                          <span className="text-ink-muted">
                            {allocation.purpose || "no stated purpose"}
                          </span>
                          <span className="ml-1.5 text-ink-subtle">
                            {allocation.team_name}
                            {allocation.holder_name
                              ? ` · ${allocation.holder_name}`
                              : ""}{" "}
                            · {allocation.allocation_type}
                            {allocation.released_at
                              ? ` · released ${formatRelative(allocation.released_at)}`
                              : allocation.expires_at
                                ? ` · expires ${formatRelative(allocation.expires_at)}`
                                : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Resources" />
        <ConnectionError error={error} />
      </>
    );
  }
}

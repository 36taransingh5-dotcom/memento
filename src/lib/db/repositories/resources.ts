import { query, queryOne, transaction } from "@/lib/db/client";
import type {
  Resource,
  ResourceAllocation,
  ResourceKind,
  ResourceWithContext,
} from "@/lib/db/types";

/**
 * Resource reads always join the *active* allocation (one that has not been
 * released), because "who currently holds this and until when" is the fact that
 * changes the agent's answer.
 */
const RESOURCE_WITH_CONTEXT = `
  SELECT r.*,
         t.name AS owner_team_name,
         a.id           AS active_allocation_id,
         a.allocation_type,
         a.expires_at   AS allocation_expires_at,
         a.purpose      AS allocation_purpose,
         holder.name    AS allocation_holder
    FROM resources r
    LEFT JOIN teams t ON t.id = r.owner_team_id
    LEFT JOIN resource_allocations a
           ON a.resource_id = r.id AND a.released_at IS NULL
    LEFT JOIN users holder ON holder.id = a.user_id
`;

export async function listResources(): Promise<ResourceWithContext[]> {
  return query<ResourceWithContext>(
    `${RESOURCE_WITH_CONTEXT} ORDER BY r.kind, r.key`,
  );
}

export async function getResourceById(
  id: string,
): Promise<ResourceWithContext | null> {
  return queryOne<ResourceWithContext>(
    `${RESOURCE_WITH_CONTEXT} WHERE r.id = $1`,
    [id],
  );
}

export async function listTeamResources(
  teamId: string,
  kind?: ResourceKind,
): Promise<ResourceWithContext[]> {
  if (kind) {
    return query<ResourceWithContext>(
      `${RESOURCE_WITH_CONTEXT}
        WHERE r.owner_team_id = $1 AND r.kind = $2
        ORDER BY r.status, r.key`,
      [teamId, kind],
    );
  }
  return query<ResourceWithContext>(
    `${RESOURCE_WITH_CONTEXT}
      WHERE r.owner_team_id = $1
      ORDER BY r.kind, r.key`,
    [teamId],
  );
}

/**
 * Resources that could satisfy a request without provisioning anything new:
 * either idle and already owned by the team, or unassigned in the pool.
 *
 * This is the query behind `check_availability` — the single most important
 * tool in the agent's kit, and the one an amnesiac agent never thinks to run.
 */
export async function findReusableResources(
  teamId: string,
  kind: ResourceKind,
): Promise<ResourceWithContext[]> {
  return query<ResourceWithContext>(
    `${RESOURCE_WITH_CONTEXT}
      WHERE r.kind = $2
        AND r.status IN ('idle', 'available')
        AND (r.owner_team_id = $1 OR r.owner_team_id IS NULL)
      ORDER BY
        -- Prefer capacity the team already owns over pulling from the pool.
        (r.owner_team_id = $1) DESC,
        r.utilization_percent ASC,
        r.key`,
    [teamId, kind],
  );
}

/**
 * Allocations expiring inside `withinDays`. A temporary GPU that frees up
 * tomorrow is a reason to wait, not to provision.
 */
export async function findExpiringAllocations(
  teamId: string,
  withinDays: number,
): Promise<
  Array<
    ResourceAllocation & {
      resource_name: string;
      resource_key: string;
      resource_kind: ResourceKind;
      holder_name: string | null;
    }
  >
> {
  return query(
    `SELECT a.*,
            r.name AS resource_name,
            r.key  AS resource_key,
            r.kind AS resource_kind,
            u.name AS holder_name
       FROM resource_allocations a
       JOIN resources r ON r.id = a.resource_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.team_id = $1
        AND a.released_at IS NULL
        AND a.expires_at IS NOT NULL
        AND a.expires_at <= now() + ($2 || ' days')::INTERVAL
      ORDER BY a.expires_at ASC`,
    [teamId, String(withinDays)],
  );
}

export interface TeamResourceUsage {
  kind: ResourceKind;
  total: number;
  in_use: number;
  idle: number;
  monthly_cost_usd: number;
}

export async function getTeamResourceUsage(
  teamId: string,
): Promise<TeamResourceUsage[]> {
  return query<TeamResourceUsage>(
    `SELECT kind,
            count(*)::INT                                      AS total,
            count(*) FILTER (WHERE status = 'in_use')::INT     AS in_use,
            count(*) FILTER (WHERE status = 'idle')::INT       AS idle,
            coalesce(sum(monthly_cost_usd), 0)                 AS monthly_cost_usd
       FROM resources
      WHERE owner_team_id = $1 AND status <> 'retired'
      GROUP BY kind
      ORDER BY kind`,
    [teamId],
  );
}

export async function listAllocationsForResource(
  resourceId: string,
): Promise<
  Array<ResourceAllocation & { team_name: string; holder_name: string | null }>
> {
  return query(
    `SELECT a.*, t.name AS team_name, u.name AS holder_name
       FROM resource_allocations a
       JOIN teams t ON t.id = a.team_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.resource_id = $1
      ORDER BY a.starts_at DESC`,
    [resourceId],
  );
}

/**
 * Assign an idle resource to a requester. Status flip and allocation insert
 * happen in one transaction so a resource can never appear both idle and held.
 */
export async function allocateResource(input: {
  resourceId: string;
  teamId: string;
  userId: string | null;
  requestId: string | null;
  allocationType: "permanent" | "temporary";
  purpose: string;
  durationDays: number | null;
}): Promise<ResourceAllocation> {
  return transaction(async (tx) => {
    const expiresAt =
      input.allocationType === "temporary"
        ? new Date(
            Date.now() + (input.durationDays ?? 7) * 24 * 60 * 60 * 1000,
          )
        : null;

    const rows = await tx.query<ResourceAllocation>(
      `INSERT INTO resource_allocations
         (resource_id, team_id, user_id, request_id, allocation_type, purpose, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.resourceId,
        input.teamId,
        input.userId,
        input.requestId,
        input.allocationType,
        input.purpose,
        expiresAt,
      ],
    );

    await tx.query(
      `UPDATE resources
          SET status = 'in_use',
              owner_team_id = coalesce(owner_team_id, $2),
              updated_at = now()
        WHERE id = $1`,
      [input.resourceId, input.teamId],
    );

    const allocation = rows[0];
    if (!allocation) throw new Error("Failed to create resource allocation");
    return allocation;
  });
}

export async function releaseAllocation(
  allocationId: string,
): Promise<Resource | null> {
  return transaction(async (tx) => {
    const released = await tx.queryOne<ResourceAllocation>(
      `UPDATE resource_allocations
          SET released_at = now()
        WHERE id = $1 AND released_at IS NULL
        RETURNING *`,
      [allocationId],
    );
    if (!released) return null;

    return tx.queryOne<Resource>(
      `UPDATE resources
          SET status = 'idle', utilization_percent = 0, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [released.resource_id],
    );
  });
}

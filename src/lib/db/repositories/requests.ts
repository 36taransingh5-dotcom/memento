import { query, queryOne, transaction } from "@/lib/db/client";
import type {
  OperationalRequest,
  RequestEvent,
  RequestStatus,
  RequestType,
  RequestWithContext,
  ResourceKind,
} from "@/lib/db/types";

const REQUEST_WITH_CONTEXT = `
  SELECT r.*,
         u.name  AS requester_name,
         u.email AS requester_email,
         t.name  AS team_name,
         d.decision   AS latest_decision,
         d.created_at AS latest_decision_at
    FROM requests r
    JOIN users u ON u.id = r.requester_id
    JOIN teams t ON t.id = r.team_id
    LEFT JOIN LATERAL (
      SELECT decision, created_at
        FROM agent_decisions
       WHERE request_id = r.id
       ORDER BY created_at DESC
       LIMIT 1
    ) d ON true
`;

export async function listRequests(
  filter: { status?: RequestStatus; teamId?: string; limit?: number } = {},
): Promise<RequestWithContext[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    params.push(filter.status);
    clauses.push(`r.status = $${params.length}`);
  }
  if (filter.teamId) {
    params.push(filter.teamId);
    clauses.push(`r.team_id = $${params.length}`);
  }

  params.push(filter.limit ?? 100);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return query<RequestWithContext>(
    `${REQUEST_WITH_CONTEXT} ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length}`,
    params as never,
  );
}

export async function getRequestById(
  id: string,
): Promise<RequestWithContext | null> {
  return queryOne<RequestWithContext>(
    `${REQUEST_WITH_CONTEXT} WHERE r.id = $1`,
    [id],
  );
}

export async function getRequestByReference(
  reference: string,
): Promise<RequestWithContext | null> {
  return queryOne<RequestWithContext>(
    `${REQUEST_WITH_CONTEXT} WHERE r.reference = $1`,
    [reference],
  );
}

/**
 * Exact historical requests for a requester or their team. This is *structured*
 * recall — precise and complete — as distinct from semantic recall, which finds
 * things nobody thought to index. The agent uses both.
 */
export async function getRequestHistory(input: {
  userId?: string;
  teamId?: string;
  resourceKind?: ResourceKind | null;
  lookbackDays?: number;
  limit?: number;
}): Promise<RequestWithContext[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (input.userId) {
    params.push(input.userId);
    clauses.push(`r.requester_id = $${params.length}`);
  }
  if (input.teamId) {
    params.push(input.teamId);
    clauses.push(`r.team_id = $${params.length}`);
  }
  if (input.resourceKind) {
    params.push(input.resourceKind);
    clauses.push(`r.resource_kind = $${params.length}`);
  }
  if (input.lookbackDays) {
    params.push(String(input.lookbackDays));
    clauses.push(`r.created_at >= now() - ($${params.length} || ' days')::INTERVAL`);
  }

  params.push(input.limit ?? 25);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return query<RequestWithContext>(
    `${REQUEST_WITH_CONTEXT} ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length}`,
    params as never,
  );
}

export interface CreateRequestInput {
  requesterId: string;
  teamId: string;
  title: string;
  body: string;
  requestType: RequestType;
  resourceKind?: ResourceKind | null;
  quantity?: number;
  estimatedMonthlyCostUsd?: number | null;
  vendor?: string | null;
  environment?: string | null;
  durationDays?: number | null;
}

/**
 * Creates the request and its first timeline event atomically, allocating a
 * human-friendly reference (REQ-1043) from the current row count.
 */
export async function createRequest(
  input: CreateRequestInput,
): Promise<OperationalRequest> {
  return transaction(async (tx) => {
    const seq = await tx.queryOne<{ next: number }>(
      `SELECT coalesce(max(
                CASE WHEN reference ~ '^REQ-[0-9]+$'
                     THEN substring(reference FROM 5)::INT
                     ELSE 0 END
              ), 1000)::INT + 1 AS next
         FROM requests`,
    );
    const reference = `REQ-${seq?.next ?? 1001}`;

    const rows = await tx.query<OperationalRequest>(
      `INSERT INTO requests
         (reference, requester_id, team_id, title, body, request_type,
          resource_kind, quantity, estimated_monthly_cost_usd, vendor,
          environment, duration_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        reference,
        input.requesterId,
        input.teamId,
        input.title,
        input.body,
        input.requestType,
        input.resourceKind ?? null,
        input.quantity ?? 1,
        input.estimatedMonthlyCostUsd ?? null,
        input.vendor ?? null,
        input.environment ?? null,
        input.durationDays ?? null,
      ],
    );

    const created = rows[0];
    if (!created) throw new Error("Failed to create request");

    await tx.query(
      `INSERT INTO request_events (request_id, event_type, actor_type, actor_id, summary, payload)
       VALUES ($1, 'created', 'user', $2, $3, $4)`,
      [
        created.id,
        input.requesterId,
        `Request submitted: ${input.title}`,
        JSON.stringify({ body: input.body }),
      ],
    );

    return created;
  });
}

export async function updateRequestStatus(
  requestId: string,
  status: RequestStatus,
): Promise<OperationalRequest | null> {
  const resolved: RequestStatus[] = [
    "approved",
    "rejected",
    "fulfilled",
    "withdrawn",
  ];
  return queryOne<OperationalRequest>(
    `UPDATE requests
        SET status = $2,
            updated_at = now(),
            resolved_at = CASE WHEN $2 = ANY($3) THEN now() ELSE resolved_at END
      WHERE id = $1
      RETURNING *`,
    [requestId, status, resolved],
  );
}

export async function addRequestEvent(input: {
  requestId: string;
  eventType: string;
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  summary: string;
  payload?: Record<string, unknown>;
}): Promise<RequestEvent> {
  const rows = await query<RequestEvent>(
    `INSERT INTO request_events
       (request_id, event_type, actor_type, actor_id, summary, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.requestId,
      input.eventType,
      input.actorType,
      input.actorId ?? null,
      input.summary,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  const event = rows[0];
  if (!event) throw new Error("Failed to record request event");
  return event;
}

export async function listRequestEvents(
  requestId: string,
): Promise<RequestEvent[]> {
  return query<RequestEvent>(
    `SELECT * FROM request_events WHERE request_id = $1 ORDER BY created_at ASC`,
    [requestId],
  );
}

export interface RequestStatusCounts {
  status: RequestStatus;
  count: number;
}

export async function countRequestsByStatus(): Promise<RequestStatusCounts[]> {
  return query<RequestStatusCounts>(
    `SELECT status, count(*)::INT AS count
       FROM requests
      GROUP BY status
      ORDER BY count DESC`,
  );
}

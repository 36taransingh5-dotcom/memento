import { query } from "@/lib/db/client";
import type { AuditEvent, AuditEventWithContext } from "@/lib/db/types";

/**
 * Every tool call, retrieval, policy evaluation, and action the agent performs
 * lands here. This is the record that makes the agent reviewable by a human —
 * what it looked at, what it found, and what it did about it.
 *
 * It deliberately does not store the model's private reasoning.
 */

export type AuditAction =
  | "session.started"
  | "session.completed"
  | "tool.invoked"
  | "memory.retrieved"
  | "memory.created"
  | "policy.evaluated"
  | "decision.recorded"
  | "action.executed"
  | "approval.requested"
  | "approval.resolved"
  | "error";

export async function recordAuditEvent(input: {
  sessionId?: string | null;
  requestId?: string | null;
  actorType?: "user" | "agent" | "system";
  actorId?: string | null;
  action: AuditAction;
  toolName?: string | null;
  parameters?: Record<string, unknown>;
  resultSummary?: string;
  durationMs?: number;
  isError?: boolean;
}): Promise<AuditEvent | null> {
  try {
    const rows = await query<AuditEvent>(
      `INSERT INTO audit_events
         (session_id, request_id, actor_type, actor_id, action, tool_name,
          parameters, result_summary, duration_ms, is_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.sessionId ?? null,
        input.requestId ?? null,
        input.actorType ?? "agent",
        input.actorId ?? null,
        input.action,
        input.toolName ?? null,
        JSON.stringify(input.parameters ?? {}),
        input.resultSummary ?? "",
        input.durationMs ?? 0,
        input.isError ?? false,
      ],
    );
    return rows[0] ?? null;
  } catch (err) {
    // Auditing must never take down the operation it is auditing. Log loudly so
    // a persistent failure is still visible in operations.
    console.error(
      "[audit] failed to record event:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function listAuditEvents(
  filter: {
    sessionId?: string;
    requestId?: string;
    limit?: number;
    onlyErrors?: boolean;
  } = {},
): Promise<AuditEventWithContext[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.sessionId) {
    params.push(filter.sessionId);
    clauses.push(`a.session_id = $${params.length}`);
  }
  if (filter.requestId) {
    params.push(filter.requestId);
    clauses.push(`a.request_id = $${params.length}`);
  }
  if (filter.onlyErrors) clauses.push("a.is_error = true");

  params.push(filter.limit ?? 200);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return query<AuditEventWithContext>(
    `SELECT a.*, r.reference AS request_reference, u.name AS actor_name
       FROM audit_events a
       LEFT JOIN requests r ON r.id = a.request_id
       LEFT JOIN users u ON u.id = a.actor_id
       ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}`,
    params as never,
  );
}

/**
 * Reconstruct the exact state of the audit log as of a past instant, using
 * CockroachDB's `AS OF SYSTEM TIME`. Reviewing a decision months later means
 * seeing what the agent saw, not what the data has since become.
 *
 * The timestamp must be inside the cluster's garbage-collection window
 * (25 hours by default); outside it CockroachDB raises a "batch timestamp must
 * be after replica GC threshold" error, which we translate into an empty result.
 */
export async function listAuditEventsAsOf(
  timestamp: Date,
  limit = 200,
): Promise<{ events: AuditEventWithContext[]; available: boolean }> {
  try {
    const events = await query<AuditEventWithContext>(
      `SELECT a.*, r.reference AS request_reference, u.name AS actor_name
         FROM audit_events AS OF SYSTEM TIME $1 a
         LEFT JOIN requests r ON r.id = a.request_id
         LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [timestamp.toISOString(), limit],
    );
    return { events, available: true };
  } catch {
    return { events: [], available: false };
  }
}

export interface AuditSummary {
  total_events: number;
  tool_invocations: number;
  memories_created: number;
  errors: number;
}

export async function getAuditSummary(): Promise<AuditSummary> {
  const rows = await query<AuditSummary>(
    `SELECT count(*)::INT AS total_events,
            count(*) FILTER (WHERE action = 'tool.invoked')::INT AS tool_invocations,
            count(*) FILTER (WHERE action = 'memory.created')::INT AS memories_created,
            count(*) FILTER (WHERE is_error)::INT AS errors
       FROM audit_events`,
  );
  return (
    rows[0] ?? {
      total_events: 0,
      tool_invocations: 0,
      memories_created: 0,
      errors: 0,
    }
  );
}

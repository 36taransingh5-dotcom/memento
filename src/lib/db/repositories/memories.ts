import { query, queryOne } from "@/lib/db/client";
import type {
  AgentMemory,
  MemoryType,
  MemoryWithContext,
  RetrievedMemory,
} from "@/lib/db/types";

/**
 * Semantic memory storage backed by CockroachDB's native VECTOR type.
 *
 * Retrieval uses the `<=>` cosine-distance operator, which is served by the
 * C-SPANN distributed vector index when it exists (db/migrations/003) and by an
 * exact scan when it does not. The SQL is identical either way — the index is a
 * scalability property, not a correctness one.
 */

/** CockroachDB parses `'[0.1,0.2,...]'` into VECTOR. */
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

const MEMORY_CONTEXT_JOINS = `
    LEFT JOIN teams     tm ON tm.id = m.subject_team_id
    LEFT JOIN users     us ON us.id = m.subject_user_id
    LEFT JOIN resources rs ON rs.id = m.subject_resource_id
    LEFT JOIN requests  rq ON rq.id = m.source_request_id
`;

const MEMORY_CONTEXT_COLUMNS = `
         tm.name      AS team_name,
         us.name      AS user_name,
         rs.name      AS resource_name,
         rq.reference AS source_request_reference,
         rq.title     AS source_request_title
`;

export interface CreateMemoryInput {
  content: string;
  summary: string;
  memoryType: MemoryType;
  importance?: number;
  embedding?: readonly number[] | null;
  embeddingModel?: string | null;
  sourceKind?: "request" | "decision" | "allocation" | "manual" | "system";
  sourceRequestId?: string | null;
  sourceDecisionId?: string | null;
  subjectTeamId?: string | null;
  subjectUserId?: string | null;
  subjectResourceId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  expiresAt?: Date | null;
}

export async function createMemory(
  input: CreateMemoryInput,
): Promise<AgentMemory> {
  const rows = await query<AgentMemory>(
    `INSERT INTO agent_memories
       (content, summary, memory_type, importance, embedding, embedding_model,
        source_kind, source_request_id, source_decision_id, subject_team_id,
        subject_user_id, subject_resource_id, metadata, occurred_at, expires_at)
     VALUES ($1, $2, $3, $4, $5::VECTOR, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, content, summary, memory_type, importance, embedding_model,
               source_kind, source_request_id, source_decision_id, subject_team_id,
               subject_user_id, subject_resource_id, metadata, occurred_at,
               expires_at, superseded_by, created_at`,
    [
      input.content,
      input.summary,
      input.memoryType,
      input.importance ?? 3,
      input.embedding ? toVectorLiteral(input.embedding) : null,
      input.embeddingModel ?? null,
      input.sourceKind ?? "system",
      input.sourceRequestId ?? null,
      input.sourceDecisionId ?? null,
      input.subjectTeamId ?? null,
      input.subjectUserId ?? null,
      input.subjectResourceId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.occurredAt ?? new Date(),
      input.expiresAt ?? null,
    ],
  );
  const memory = rows[0];
  if (!memory) throw new Error("Failed to create memory");
  return memory;
}

export interface SearchOptions {
  limit?: number;
  /** Discard results below this cosine similarity. */
  minSimilarity?: number;
  teamId?: string | null;
  userId?: string | null;
  memoryTypes?: readonly MemoryType[];
}

/**
 * Nearest-neighbour search over semantic memory.
 *
 * The candidate CTE touches only `agent_memories` so the vector index can serve
 * the ORDER BY ... LIMIT; context joins and validity filters are applied
 * afterwards. We over-fetch (`limit * 4`) so post-filtering still returns a full
 * page — the standard approximate-nearest-neighbour pattern.
 */
export async function searchMemories(
  embedding: readonly number[],
  options: SearchOptions = {},
): Promise<RetrievedMemory[]> {
  const limit = options.limit ?? 5;
  const minSimilarity = options.minSimilarity ?? 0;
  const overFetch = Math.max(limit * 4, 20);

  const params: unknown[] = [toVectorLiteral(embedding), overFetch];
  const filters: string[] = [
    "m.superseded_by IS NULL",
    "(m.expires_at IS NULL OR m.expires_at > now())",
  ];

  if (options.teamId) {
    params.push(options.teamId);
    filters.push(
      `(m.subject_team_id IS NULL OR m.subject_team_id = $${params.length})`,
    );
  }
  if (options.userId) {
    params.push(options.userId);
    filters.push(
      `(m.subject_user_id IS NULL OR m.subject_user_id = $${params.length})`,
    );
  }
  if (options.memoryTypes?.length) {
    params.push([...options.memoryTypes]);
    filters.push(`m.memory_type = ANY($${params.length})`);
  }

  params.push(minSimilarity);
  const minSimilarityParam = `$${params.length}`;
  params.push(limit);
  const limitParam = `$${params.length}`;

  return query<RetrievedMemory>(
    `WITH candidates AS (
       SELECT id, embedding <=> $1::VECTOR AS distance
         FROM agent_memories
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::VECTOR
        LIMIT $2
     )
     SELECT m.id, m.content, m.summary, m.memory_type, m.importance,
            m.embedding_model, m.source_kind, m.source_request_id,
            m.source_decision_id, m.subject_team_id, m.subject_user_id,
            m.subject_resource_id, m.metadata, m.occurred_at, m.expires_at,
            m.superseded_by, m.created_at,
            ${MEMORY_CONTEXT_COLUMNS},
            (1 - c.distance) AS similarity
       FROM candidates c
       JOIN agent_memories m ON m.id = c.id
       ${MEMORY_CONTEXT_JOINS}
      WHERE ${filters.join(" AND ")}
        AND (1 - c.distance) >= ${minSimilarityParam}
      ORDER BY c.distance ASC
      LIMIT ${limitParam}`,
    params as never,
  );
}

export async function listMemories(
  filter: { memoryType?: MemoryType; teamId?: string; limit?: number } = {},
): Promise<MemoryWithContext[]> {
  const params: unknown[] = [];
  const clauses: string[] = ["m.superseded_by IS NULL"];

  if (filter.memoryType) {
    params.push(filter.memoryType);
    clauses.push(`m.memory_type = $${params.length}`);
  }
  if (filter.teamId) {
    params.push(filter.teamId);
    clauses.push(`m.subject_team_id = $${params.length}`);
  }

  params.push(filter.limit ?? 100);

  return query<MemoryWithContext>(
    `SELECT m.id, m.content, m.summary, m.memory_type, m.importance,
            m.embedding_model, m.source_kind, m.source_request_id,
            m.source_decision_id, m.subject_team_id, m.subject_user_id,
            m.subject_resource_id, m.metadata, m.occurred_at, m.expires_at,
            m.superseded_by, m.created_at,
            ${MEMORY_CONTEXT_COLUMNS}
       FROM agent_memories m
       ${MEMORY_CONTEXT_JOINS}
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.occurred_at DESC
      LIMIT $${params.length}`,
    params as never,
  );
}

export async function getMemoryById(
  id: string,
): Promise<MemoryWithContext | null> {
  return queryOne<MemoryWithContext>(
    `SELECT m.id, m.content, m.summary, m.memory_type, m.importance,
            m.embedding_model, m.source_kind, m.source_request_id,
            m.source_decision_id, m.subject_team_id, m.subject_user_id,
            m.subject_resource_id, m.metadata, m.occurred_at, m.expires_at,
            m.superseded_by, m.created_at,
            ${MEMORY_CONTEXT_COLUMNS}
       FROM agent_memories m
       ${MEMORY_CONTEXT_JOINS}
      WHERE m.id = $1`,
    [id],
  );
}

/**
 * Memory evolution: when a fact changes, the old memory is not deleted — it is
 * marked superseded so the audit trail keeps the original, while retrieval only
 * ever returns the current one.
 */
export async function supersedeMemory(
  oldId: string,
  newId: string,
): Promise<void> {
  await query(`UPDATE agent_memories SET superseded_by = $2 WHERE id = $1`, [
    oldId,
    newId,
  ]);
}

export async function backfillEmbedding(
  id: string,
  embedding: readonly number[],
  model: string,
): Promise<void> {
  await query(
    `UPDATE agent_memories SET embedding = $2::VECTOR, embedding_model = $3 WHERE id = $1`,
    [id, toVectorLiteral(embedding), model],
  );
}

export async function listMemoriesMissingEmbeddings(
  limit = 200,
): Promise<Array<{ id: string; content: string }>> {
  return query(
    `SELECT id, content FROM agent_memories WHERE embedding IS NULL LIMIT $1`,
    [limit],
  );
}

export interface MemoryStats {
  total: number;
  embedded: number;
  by_type: Array<{ memory_type: MemoryType; count: number }>;
  created_last_7_days: number;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const totals = await queryOne<{
    total: number;
    embedded: number;
    recent: number;
  }>(
    `SELECT count(*)::INT AS total,
            count(embedding)::INT AS embedded,
            count(*) FILTER (WHERE created_at > now() - INTERVAL '7 days')::INT AS recent
       FROM agent_memories
      WHERE superseded_by IS NULL`,
  );

  const byType = await query<{ memory_type: MemoryType; count: number }>(
    `SELECT memory_type, count(*)::INT AS count
       FROM agent_memories
      WHERE superseded_by IS NULL
      GROUP BY memory_type
      ORDER BY count DESC`,
  );

  return {
    total: totals?.total ?? 0,
    embedded: totals?.embedded ?? 0,
    created_last_7_days: totals?.recent ?? 0,
    by_type: byType,
  };
}

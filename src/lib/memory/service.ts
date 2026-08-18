import { embed } from "@/lib/ai/embeddings";
import * as memories from "@/lib/db/repositories/memories";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import type {
  AgentMemory,
  MemoryReference,
  MemoryType,
  RetrievedMemory,
} from "@/lib/db/types";

/**
 * The memory system.
 *
 * Two operations matter: writing a durable memory when something meaningful
 * happens, and retrieving the right memories when a new request arrives. Both
 * go through Bedrock for embeddings and CockroachDB for storage and search.
 */

export interface RememberInput {
  content: string;
  summary: string;
  memoryType: MemoryType;
  importance?: number;
  sourceKind?: "request" | "decision" | "allocation" | "manual" | "system";
  sourceRequestId?: string | null;
  sourceDecisionId?: string | null;
  subjectTeamId?: string | null;
  subjectUserId?: string | null;
  subjectResourceId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  expiresAt?: Date | null;
  /** Marks an older memory as replaced by this one. */
  supersedesMemoryId?: string | null;
  sessionId?: string | null;
}

/**
 * Persist an event as long-term memory.
 *
 * The embedding failing must not lose the memory: we store the row either way
 * and leave `embedding` NULL, which `npm run db:health` reports and
 * `backfillMissingEmbeddings()` repairs. A memory that exists but is not yet
 * searchable is strictly better than a memory that was never written.
 */
export async function remember(input: RememberInput): Promise<AgentMemory> {
  let embedding: number[] | null = null;
  let embeddingModel: string | null = null;

  try {
    const result = await embed(input.content);
    embedding = result.vector;
    embeddingModel = result.model;
  } catch (err) {
    console.error(
      "[memory] embedding failed, storing memory without a vector:",
      err instanceof Error ? err.message : err,
    );
  }

  const memory = await memories.createMemory({
    ...input,
    embedding,
    embeddingModel,
  });

  if (input.supersedesMemoryId) {
    await memories.supersedeMemory(input.supersedesMemoryId, memory.id);
  }

  await recordAuditEvent({
    sessionId: input.sessionId ?? null,
    requestId: input.sourceRequestId ?? null,
    action: "memory.created",
    resultSummary: `Stored ${input.memoryType} memory: ${input.summary}`,
    parameters: {
      memory_id: memory.id,
      memory_type: input.memoryType,
      embedded: embedding !== null,
      embedding_model: embeddingModel,
      supersedes: input.supersedesMemoryId ?? null,
    },
  });

  return memory;
}

export interface RecallOptions {
  limit?: number;
  minSimilarity?: number;
  teamId?: string | null;
  userId?: string | null;
  memoryTypes?: readonly MemoryType[];
  sessionId?: string | null;
  requestId?: string | null;
}

/**
 * Semantic retrieval: embed the query, then nearest-neighbour search in
 * CockroachDB.
 *
 * The default `minSimilarity` of 0.15 exists because an embedding space always
 * returns *something*; without a floor the agent would cite irrelevant memories
 * as evidence, which is worse than citing none.
 */
export async function recall(
  queryText: string,
  options: RecallOptions = {},
): Promise<RetrievedMemory[]> {
  const started = Date.now();
  const { vector } = await embed(queryText);

  const results = await memories.searchMemories(vector, {
    limit: options.limit ?? 5,
    minSimilarity: options.minSimilarity ?? 0.15,
    teamId: options.teamId,
    userId: options.userId,
    memoryTypes: options.memoryTypes,
  });

  await recordAuditEvent({
    sessionId: options.sessionId ?? null,
    requestId: options.requestId ?? null,
    action: "memory.retrieved",
    parameters: {
      query: queryText,
      limit: options.limit ?? 5,
      returned: results.length,
    },
    resultSummary:
      results.length === 0
        ? "No semantic memories passed the similarity threshold"
        : `Retrieved ${results.length} semantic ${
            results.length === 1 ? "memory" : "memories"
          } (top similarity ${results[0]?.similarity.toFixed(3)})`,
    durationMs: Date.now() - started,
  });

  return results;
}

/** Compact form embedded in the decision record and rendered in the UI. */
export function toMemoryReferences(
  retrieved: readonly RetrievedMemory[],
): MemoryReference[] {
  return retrieved.map((m) => ({
    id: m.id,
    summary: m.summary,
    content: m.content,
    similarity: Number(m.similarity.toFixed(4)),
    memory_type: m.memory_type,
    occurred_at: new Date(m.occurred_at).toISOString(),
  }));
}

/**
 * Re-embed memories written while the embedding provider was unavailable.
 * Run by `npm run db:health --fix` and safe to run repeatedly.
 */
export async function backfillMissingEmbeddings(
  limit = 200,
): Promise<{ repaired: number; failed: number }> {
  const pending = await memories.listMemoriesMissingEmbeddings(limit);
  let repaired = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const { vector, model } = await embed(row.content);
      await memories.backfillEmbedding(row.id, vector, model);
      repaired += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[memory] backfill failed for ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { repaired, failed };
}

export { getMemoryById, getMemoryStats, listMemories } from "@/lib/db/repositories/memories";

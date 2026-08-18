-- ===========================================================================
-- C-SPANN vector index over semantic memory.
--
-- `vector_cosine_ops` matches the `<=>` (cosine distance) operator used by
-- MemoryService.search(). Embeddings are L2-normalised before insert, so cosine
-- distance is the correct similarity metric for retrieval.
--
-- Optional by design — see 002_vector_index_setting.optional.sql.
-- ===========================================================================

CREATE VECTOR INDEX IF NOT EXISTS memories_embedding_cspann_idx
    ON agent_memories (embedding vector_cosine_ops);

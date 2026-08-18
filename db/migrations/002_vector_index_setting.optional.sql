-- ===========================================================================
-- Enable CockroachDB's distributed vector index (C-SPANN), introduced in v25.2.
--
-- `.optional.sql` — the migration runner treats a failure here as a warning,
-- not an error. Memento's semantic retrieval works either way:
--
--   index present  ->  C-SPANN approximate nearest-neighbour search, scales to
--                      millions of memories across a distributed cluster
--   index absent   ->  exact cosine scan using the same `<=>` operator
--
-- The query in src/lib/memory/service.ts is identical in both cases, so the
-- demo never breaks because a cluster setting was unavailable.
--
-- `SET CLUSTER SETTING` cannot run inside an explicit transaction, which is why
-- the runner executes migrations outside one.
-- ===========================================================================

SET CLUSTER SETTING feature.vector_index.enabled = true;

-- ===========================================================================
-- Memento — core schema
--
-- CockroachDB is the agent's memory, not merely its storage. The schema is
-- split into two complementary halves that the agent queries together:
--
--   STRUCTURED MEMORY  exact organizational facts — who, which team, which
--                      resource, what was decided, what is still allocated.
--
--   SEMANTIC MEMORY    `agent_memories`, embedded into a CockroachDB VECTOR
--                      column and retrieved by cosine distance. This is what
--                      lets the agent recall *why* something happened months
--                      ago, in language nobody thought to index.
--
-- Every semantic memory carries foreign keys back to the structured event that
-- produced it, so a retrieved memory is always traceable to a real record.
-- ===========================================================================


-- --- Organization ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS teams (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key                  STRING NOT NULL UNIQUE,
    name                 STRING NOT NULL,
    description          STRING NOT NULL DEFAULT '',
    -- Budget and caps are read by the deterministic policy engine. They live in
    -- the database (not in prompt text) so the LLM cannot invent or bend them.
    monthly_budget_usd   DECIMAL(12, 2) NOT NULL DEFAULT 0,
    monthly_spend_usd    DECIMAL(12, 2) NOT NULL DEFAULT 0,
    gpu_cap              INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT budget_non_negative CHECK (monthly_budget_usd >= 0),
    CONSTRAINT spend_non_negative CHECK (monthly_spend_usd >= 0)
);

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       STRING NOT NULL UNIQUE,
    name        STRING NOT NULL,
    title       STRING NOT NULL DEFAULT '',
    team_id     UUID NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
    -- `role` determines who can approve an escalation. The agent never grants
    -- itself authority it does not have; it escalates to a role.
    role        STRING NOT NULL DEFAULT 'member',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT role_valid CHECK (role IN ('member', 'lead', 'admin'))
);

CREATE INDEX IF NOT EXISTS users_team_idx ON users (team_id);


-- --- Resources -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resources (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key                  STRING NOT NULL UNIQUE,
    name                 STRING NOT NULL,
    kind                 STRING NOT NULL,
    -- Free-form specification (GPU memory, instance class, seat count, ...).
    specification        JSONB NOT NULL DEFAULT '{}'::JSONB,
    vendor               STRING NULL,
    monthly_cost_usd     DECIMAL(12, 2) NOT NULL DEFAULT 0,
    owner_team_id        UUID NULL REFERENCES teams (id) ON DELETE SET NULL,
    -- `idle` is the state that makes the demo land: the team *owns* the GPU but
    -- nothing is running on it. A naive agent never notices this.
    status               STRING NOT NULL DEFAULT 'available',
    utilization_percent  INT NOT NULL DEFAULT 0,
    region               STRING NOT NULL DEFAULT '',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT kind_valid CHECK (
        kind IN ('gpu', 'cloud_instance', 'saas_license', 'production_service')
    ),
    CONSTRAINT status_valid CHECK (
        status IN ('available', 'in_use', 'idle', 'maintenance', 'retired')
    ),
    CONSTRAINT utilization_valid CHECK (utilization_percent BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS resources_kind_status_idx ON resources (kind, status);
CREATE INDEX IF NOT EXISTS resources_owner_team_idx ON resources (owner_team_id, kind);


-- --- Requests --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS requests (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference                   STRING NOT NULL UNIQUE,
    requester_id                UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    team_id                     UUID NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
    title                       STRING NOT NULL,
    -- The requester's own words, kept verbatim for the audit trail.
    body                        STRING NOT NULL,
    request_type                STRING NOT NULL DEFAULT 'other',
    resource_kind               STRING NULL,
    quantity                    INT NOT NULL DEFAULT 1,
    estimated_monthly_cost_usd  DECIMAL(12, 2) NULL,
    vendor                      STRING NULL,
    environment                 STRING NULL,
    duration_days               INT NULL,
    status                      STRING NOT NULL DEFAULT 'pending',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at                 TIMESTAMPTZ NULL,

    CONSTRAINT request_status_valid CHECK (
        status IN (
            'pending', 'approved', 'rejected', 'needs_information',
            'under_review', 'withdrawn', 'fulfilled'
        )
    ),
    CONSTRAINT request_type_valid CHECK (
        request_type IN (
            'resource_provision', 'resource_reuse', 'saas_license',
            'service_addition', 'access', 'other'
        )
    ),
    CONSTRAINT quantity_positive CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS requests_team_created_idx ON requests (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_requester_created_idx ON requests (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status, created_at DESC);


-- Resource allocations link a resource to a team/person for a period of time.
-- A `temporary` allocation with an `expires_at` in the near future is exactly
-- the kind of fact an amnesiac agent misses and Memento does not.
CREATE TABLE IF NOT EXISTS resource_allocations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id      UUID NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
    team_id          UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    user_id          UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    request_id       UUID NULL REFERENCES requests (id) ON DELETE SET NULL,
    allocation_type  STRING NOT NULL DEFAULT 'permanent',
    purpose          STRING NOT NULL DEFAULT '',
    starts_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NULL,
    released_at      TIMESTAMPTZ NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT allocation_type_valid CHECK (allocation_type IN ('permanent', 'temporary')),
    CONSTRAINT temporary_allocations_expire CHECK (
        allocation_type = 'permanent' OR expires_at IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS allocations_team_idx ON resource_allocations (team_id, released_at);
CREATE INDEX IF NOT EXISTS allocations_resource_idx ON resource_allocations (resource_id, released_at);
CREATE INDEX IF NOT EXISTS allocations_expiry_idx ON resource_allocations (expires_at)
    WHERE released_at IS NULL;


CREATE TABLE IF NOT EXISTS request_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id  UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    event_type  STRING NOT NULL,
    actor_type  STRING NOT NULL DEFAULT 'system',
    actor_id    UUID NULL,
    summary     STRING NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT actor_type_valid CHECK (actor_type IN ('user', 'agent', 'system'))
);

CREATE INDEX IF NOT EXISTS request_events_request_idx ON request_events (request_id, created_at);


-- --- Deterministic policy ---------------------------------------------------

-- Policies are DATA, not prompt text. The engine in src/lib/policy evaluates
-- them in TypeScript; the LLM is never asked to recall or invent a rule.
-- `severity = 'hard'` means the model's proposal cannot override the verdict.
CREATE TABLE IF NOT EXISTS policies (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key          STRING NOT NULL UNIQUE,
    name         STRING NOT NULL,
    description  STRING NOT NULL,
    category     STRING NOT NULL,
    severity     STRING NOT NULL DEFAULT 'soft',
    effect       STRING NOT NULL,
    -- Parameters read by the evaluator, e.g. {"lookback_days": 30}.
    rule         JSONB NOT NULL DEFAULT '{}'::JSONB,
    enabled      BOOL NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT policy_severity_valid CHECK (severity IN ('hard', 'soft')),
    CONSTRAINT policy_category_valid CHECK (
        category IN ('resource', 'budget', 'vendor', 'security', 'process')
    ),
    CONSTRAINT policy_effect_valid CHECK (
        effect IN (
            'reject', 'require_approval', 'request_information',
            'flag_for_review', 'advisory'
        )
    )
);

CREATE INDEX IF NOT EXISTS policies_enabled_idx ON policies (enabled, category);


-- --- Agent execution --------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    request_id          UUID NULL REFERENCES requests (id) ON DELETE SET NULL,
    channel             STRING NOT NULL DEFAULT 'web',
    status              STRING NOT NULL DEFAULT 'active',
    model               STRING NULL,
    -- 'bedrock' when Amazon Bedrock produced the reasoning, 'deterministic'
    -- when the policy engine alone did. Surfaced in the UI — never hidden.
    reasoning_provider  STRING NOT NULL DEFAULT 'bedrock',
    input_tokens        INT NOT NULL DEFAULT 0,
    output_tokens       INT NOT NULL DEFAULT 0,
    latency_ms          INT NOT NULL DEFAULT 0,
    error               STRING NULL,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at            TIMESTAMPTZ NULL,

    CONSTRAINT session_status_valid CHECK (status IN ('active', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS agent_sessions_user_idx ON agent_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_started_idx ON agent_sessions (started_at DESC);


-- The auditable decision record. Deliberately stores an evidence trail and a
-- short rationale — never private chain-of-thought.
CREATE TABLE IF NOT EXISTS agent_decisions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id              UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    session_id              UUID NULL REFERENCES agent_sessions (id) ON DELETE SET NULL,
    decision                STRING NOT NULL,
    rationale               STRING NOT NULL,
    next_action             STRING NOT NULL DEFAULT '',
    evidence                JSONB NOT NULL DEFAULT '[]'::JSONB,
    policies_triggered      JSONB NOT NULL DEFAULT '[]'::JSONB,
    memories_used           JSONB NOT NULL DEFAULT '[]'::JSONB,
    tools_invoked           JSONB NOT NULL DEFAULT '[]'::JSONB,
    actions_taken           JSONB NOT NULL DEFAULT '[]'::JSONB,
    structured_facts_count  INT NOT NULL DEFAULT 0,
    semantic_memories_count INT NOT NULL DEFAULT 0,
    confidence              STRING NOT NULL DEFAULT 'medium',
    reasoning_provider      STRING NOT NULL DEFAULT 'bedrock',
    model                   STRING NULL,
    -- True when the deterministic engine vetoed the model's proposal. This is
    -- the production-readiness story: the LLM interprets, policy decides.
    policy_overrode_model   BOOL NOT NULL DEFAULT false,
    model_proposed_decision STRING NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT decision_valid CHECK (
        decision IN (
            'APPROVE', 'REJECT', 'REQUEST_APPROVAL',
            'REQUEST_INFORMATION', 'FLAG_FOR_REVIEW'
        )
    ),
    CONSTRAINT confidence_valid CHECK (confidence IN ('high', 'medium', 'low'))
);

CREATE INDEX IF NOT EXISTS agent_decisions_request_idx ON agent_decisions (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_decisions_created_idx ON agent_decisions (created_at DESC);


CREATE TABLE IF NOT EXISTS approvals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id    UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    decision_id   UUID NULL REFERENCES agent_decisions (id) ON DELETE SET NULL,
    required_role STRING NOT NULL DEFAULT 'lead',
    reason        STRING NOT NULL DEFAULT '',
    approver_id   UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    status        STRING NOT NULL DEFAULT 'pending',
    resolution_note STRING NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ NULL,

    CONSTRAINT approval_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT approval_role_valid CHECK (required_role IN ('lead', 'admin'))
);

CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS approvals_request_idx ON approvals (request_id);


-- --- Semantic memory (the flagship table) -----------------------------------

CREATE TABLE IF NOT EXISTS agent_memories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The text that is embedded and retrieved. Written to be self-contained so
    -- it still makes sense months later, out of its original context.
    content             STRING NOT NULL,
    summary             STRING NOT NULL DEFAULT '',
    memory_type         STRING NOT NULL DEFAULT 'event',
    importance          INT NOT NULL DEFAULT 3,

    -- CockroachDB native vector storage. Dimension must match the embedding
    -- model configured in EMBEDDING_DIMENSIONS (Titan Text Embeddings V2 = 1024).
    embedding           VECTOR(1024) NULL,
    embedding_model     STRING NULL,

    -- Provenance: every memory points back at the record that produced it, so
    -- clicking a memory in the UI always reveals a real source event.
    source_kind         STRING NOT NULL DEFAULT 'system',
    source_request_id   UUID NULL REFERENCES requests (id) ON DELETE SET NULL,
    source_decision_id  UUID NULL REFERENCES agent_decisions (id) ON DELETE SET NULL,
    subject_team_id     UUID NULL REFERENCES teams (id) ON DELETE SET NULL,
    subject_user_id     UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    subject_resource_id UUID NULL REFERENCES resources (id) ON DELETE SET NULL,

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Memory evolves: a memory can go stale, or be replaced by a newer one.
    expires_at          TIMESTAMPTZ NULL,
    superseded_by       UUID NULL REFERENCES agent_memories (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT memory_type_valid CHECK (
        memory_type IN (
            'decision', 'outcome', 'policy_exception', 'preference',
            'event', 'expiration', 'constraint'
        )
    ),
    CONSTRAINT source_kind_valid CHECK (
        source_kind IN ('request', 'decision', 'allocation', 'manual', 'system')
    ),
    CONSTRAINT importance_valid CHECK (importance BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS memories_created_idx ON agent_memories (created_at DESC);
CREATE INDEX IF NOT EXISTS memories_team_idx ON agent_memories (subject_team_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memories_user_idx ON agent_memories (subject_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memories_type_idx ON agent_memories (memory_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memories_source_request_idx ON agent_memories (source_request_id);
-- Partial index over the memories that are actually retrievable.
CREATE INDEX IF NOT EXISTS memories_live_idx ON agent_memories (occurred_at DESC)
    WHERE superseded_by IS NULL;


-- --- Audit ------------------------------------------------------------------

-- Every tool call, retrieval, policy evaluation, and action lands here.
CREATE TABLE IF NOT EXISTS audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
    request_id      UUID NULL REFERENCES requests (id) ON DELETE SET NULL,
    actor_type      STRING NOT NULL DEFAULT 'agent',
    actor_id        UUID NULL,
    action          STRING NOT NULL,
    tool_name       STRING NULL,
    parameters      JSONB NOT NULL DEFAULT '{}'::JSONB,
    result_summary  STRING NOT NULL DEFAULT '',
    duration_ms     INT NOT NULL DEFAULT 0,
    is_error        BOOL NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT audit_actor_valid CHECK (actor_type IN ('user', 'agent', 'system'))
);

CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_session_idx ON audit_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS audit_request_idx ON audit_events (request_id, created_at);

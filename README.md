# Memento

**An autonomous AI operations agent that remembers what happened, learns from organizational history, and uses persistent memory in CockroachDB to make better decisions over time.**

Built for the CockroachDB AI Hackathon.

---

## The problem

Most AI agents are effectively amnesiac. They reason well about the request in front of them, but they don't know that a near-identical request was rejected last month, that the team already owns idle capacity, or that a temporary allocation expires tomorrow. Every decision starts from zero.

## The idea

Memento gives an operations agent **persistent organizational memory** — structured facts (who, which team, which resource, what was decided) and semantic memory (why it was decided, what was learned) both live in CockroachDB. The agent retrieves both before it decides anything, and a **deterministic policy engine** — not the language model — has final say over what the organization actually permits.

### The demo, in one exchange

> **Alex Chen (AI Research):** "I need another GPU for my computer vision experiment."
>
> **Memento:** AI Research already has 2 idle A100s, and the temporary allocation on `gpu-a100-03` expires tomorrow, returning a third. Provisioning more would leave four GPUs unused. Can `gpu-a100-02` cover the run?
>
> **Alex:** "Okay, use the existing one."
>
> **Memento:** Allocated `gpu-a100-02` to Alex Chen. No new capacity was provisioned.

The agent didn't query the current database — it remembered organizational history and used it to change its decision. That memory becomes the substrate the *next* GPU request retrieves.

---

## Why persistent memory matters

An agent with only the current request can approve or reject; it cannot notice that approving would be redundant. The value in Memento is entirely in the two memory systems working together:

- **Structured memory** answers "what is true right now" — exact, queryable, transactional.
- **Semantic memory** answers "what does this remind us of" — fuzzy, associative, retrieved by meaning rather than keyword.

Neither alone produces the GPU-reuse moment above. Structured memory alone would need to be told to check for idle resources; semantic memory alone can't guarantee it's looking at live inventory. Together, one grounds the other.

---

## Architecture

```mermaid
flowchart TB
    subgraph Client["Browser"]
        UI[Next.js App Router UI]
    end

    subgraph API["Next.js API Routes"]
        AgentRoute["/api/agent"]
        ApprovalRoute["/api/approvals/:id"]
    end

    subgraph Runtime["Agent Runtime (src/lib/agent)"]
        Loop[Tool-calling loop]
        Tools[13 tools]
        Prompt[System prompt]
    end

    subgraph Policy["Deterministic Policy Engine (src/lib/policy)"]
        Rules[8 pure TypeScript rules]
        Engine[Reconciliation: hard policy > model]
    end

    subgraph Memory["Memory (src/lib/memory)"]
        Recall[recall — vector search]
        Remember[remember — embed + persist]
    end

    subgraph Bedrock["Amazon Bedrock"]
        Claude[Claude — reasoning]
        Titan[Titan Embeddings V2]
    end

    subgraph CRDB["CockroachDB"]
        Structured[(teams · users · resources\nrequests · allocations · policies)]
        Vector[(agent_memories\nVECTOR(1024) + C-SPANN index)]
        Audit[(agent_decisions · audit_events)]
    end

    UI --> AgentRoute --> Loop
    Loop <--> Claude
    Loop --> Tools
    Tools --> Structured
    Tools --> Recall --> Vector
    Tools --> Engine --> Rules
    Loop --> Remember --> Titan
    Remember --> Vector
    Engine --> Audit
    Loop --> Audit
    UI --> ApprovalRoute --> Structured
```

**The database is not a backend implementation detail — it is the agent's memory.** Every tool the agent calls reads from or writes to CockroachDB; every decision is reconciled against policy rows stored in CockroachDB; every retrieval is a vector search against CockroachDB.

---

## Agent architecture

The agent is a hand-written tool-calling loop (`src/lib/agent/runtime.ts`) against Amazon Bedrock, not a black-box chain. Thirteen tools, each independently testable:

| Tool | Purpose |
|---|---|
| `create_request` | Turns free text into a structured request |
| `get_user` / `get_team` | Structured identity and budget lookup |
| `get_resources` / `check_availability` | What the team owns; what's reusable *before* provisioning |
| `get_request_history` | Exact structured recall of past requests |
| `search_memory` | Semantic recall via CockroachDB vector search |
| `get_policies` / `evaluate_policy` | Read policy text vs. run it deterministically |
| `reserve_existing_resource` | The only path to a real allocation — gated on policy having run |
| `create_memory` | Explicit memories the model chooses to write |
| `get_audit_history` | What already happened on this request |
| `record_decision` | The single terminal tool — proposes, never finalizes |

**Approving, rejecting, and escalating are not model-callable tools.** The model can only *propose* a decision via `record_decision`; the runtime reconciles that proposal against the deterministic policy verdict and applies the effect (allocate, escalate, update status). A model that could call `approve_request` directly could route around the policy engine — holding that line is the point of the architecture.

If Amazon Bedrock is unreachable, the agent degrades to the deterministic policy engine alone rather than failing — every page says so explicitly, and the audit trail records the degradation.

## Deterministic policy engine

`src/lib/policy/rules.ts` — eight pure functions of a materialized `PolicyContext` (the request, the requester, their team's budget, what's idle, what's expiring, comparable past requests). No I/O, no model, no randomness; same input, same verdict, every time.

`hard` policies are binding: if the model proposes something laxer, `reconcile()` in `src/lib/policy/engine.ts` overrides it and the override is recorded on the decision and shown in the audit log. `soft` policies are advisory — they shape the evidence and let the model be *more* cautious, never less.

## Memory architecture

**Structured** (`teams`, `users`, `resources`, `resource_allocations`, `requests`, `policies`) — exact facts, standard relational queries.

**Semantic** (`agent_memories`) — a `VECTOR(1024)` column embedded with Amazon Titan Text Embeddings V2, retrieved by cosine distance (`<=>`) and served by CockroachDB's distributed C-SPANN vector index (introduced in v25.2) when available, an exact scan otherwise — the query is identical either way, so the demo never breaks on a cluster that doesn't expose the feature flag.

Every memory carries foreign keys back to the request or decision that produced it (`source_request_id`, `source_decision_id`) — retrieval always traces to a real event, never a free-floating string. Memory evolves: a superseded fact points at its replacement (`superseded_by`) rather than being deleted, and time-bound facts (`expires_at`) go stale automatically.

## CockroachDB integration

Two AI-related capabilities, used meaningfully rather than as boxes to check:

1. **Distributed vector indexing (C-SPANN)** — `CREATE VECTOR INDEX ... USING cspann` on `agent_memories.embedding`, powering every `search_memory` call.
2. **CockroachDB Managed MCP Server** — used as developer/operator tooling for inspecting the live cluster from an AI coding assistant. See [`docs/mcp.md`](docs/mcp.md). (Deliberately *not* wired into the agent's own reasoning loop — the agent's tools query the app's typed repository layer, which enforces the same business rules the UI does; a raw SQL MCP tool in that loop would let the model bypass them.)

Beyond the vector feature: relational schema with proper constraints and foreign keys, SERIALIZABLE transactions with automatic retry on `40001` (`src/lib/db/client.ts`), and `AS OF SYSTEM TIME` historical audit queries.

## AWS integration

**Amazon Bedrock** — `AnthropicBedrockMantle` for agent reasoning (SigV4, no separate API key), Titan Text Embeddings V2 for the vector memory. Deployment targets **AWS App Runner** or **ECS Fargate** running the Next.js `standalone` build; see [`docs/deployment.md`](docs/deployment.md).

---

## Setup

### Prerequisites

- Node.js ≥ 20.11
- Docker (for local CockroachDB) — or a CockroachDB Cloud cluster
- An AWS account with Bedrock access to Claude and Titan Embeddings (optional — see [Degraded mode](#degraded-mode))

### Quickstart

```bash
git clone <this-repo> memento && cd memento
npm install
cp .env.example .env.local        # edit if you're pointing at CockroachDB Cloud or Bedrock
npm run db:setup                  # starts CockroachDB, migrates, seeds Northstar Labs
npm run dev                       # http://localhost:3000
```

Or from the command line, no browser required:

```bash
npm run demo
```

### Environment variables

See [`.env.example`](.env.example) — every variable is documented inline. The essentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | CockroachDB connection string. Defaults to the local docker-compose cluster in development. |
| `AWS_REGION`, `BEDROCK_MODEL_ID`, `BEDROCK_EMBEDDING_MODEL_ID` | Amazon Bedrock configuration. AWS credentials are resolved via the standard SDK chain (env vars, profile, instance role) — never hardcoded. |
| `ALLOW_DEGRADED_AI` | When `true` (default), a Bedrock outage degrades to the deterministic engine instead of failing the request. |

### Database setup

```bash
npm run db:up        # docker compose up -d, waits for CockroachDB to accept connections
npm run db:migrate    # applies db/migrations/*.sql — idempotent, tracked in schema_migrations
npm run db:seed       # seeds Northstar Labs (db → src/lib/seed/northstar.ts)
npm run db:reset      # drops everything and re-runs migrate + seed — the reproducibility guarantee
npm run db:health      # checks CockroachDB, the vector index, and Bedrock reachability
```

The vector index migration (`db/migrations/003_vector_index.optional.sql`) is best-effort: if the cluster doesn't expose `feature.vector_index.enabled`, the migration is skipped with a warning and semantic search falls back to an exact cosine scan. Nothing else changes.

### Seed data

`src/lib/seed/northstar.ts` — Northstar Labs: 4 teams, 5 people, 16 resources, 8 policies, 8 historical requests with recorded decisions, 6 resource allocations, and 15 semantic memories, deliberately shaped so the GPU-reuse demo lands: AI Research owns four A100s, two sit idle, and a third is on a temporary allocation pinned to expire **tomorrow relative to whenever the seed runs** — the demo is reproducible from a clean database on any day.

### Local development

```bash
npm run dev         # Next.js dev server
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
npm run test         # vitest
```

### Deployment

See [`docs/deployment.md`](docs/deployment.md) for AWS App Runner / ECS Fargate, required IAM permissions, and CockroachDB Cloud configuration.

### Demo walkthrough

1. Open **Agent**, acting as Alex Chen (AI Research).
2. Send: *"I need another GPU for my computer vision experiment."*
3. Watch the retrieval pipeline: structured facts → semantic memory → availability check → policy evaluation → decision. Memento offers `gpu-a100-02` instead of provisioning.
4. Reply: *"Okay, use the existing one."* The agent allocates the resource and the decision flips to **APPROVE**.
5. Visit **Memory** — the new decision is now a retrievable memory. Click it to see the source request it came from.
6. Visit **Requests**, **Resources**, **Policies**, and **Audit log** to see the same event from every other angle.

---

## Technical decisions

- **CockroachDB for all persistent state**, structured and vector alike — one database, one mental model, one consistency guarantee.
- **A hand-written agent loop**, not the SDK's tool-runner helper — every tool call needs its own audited, timed row, and the audit trail is a product surface here, not a debug log.
- **Approve/reject/escalate are runtime effects, not model tools** — the one invariant the whole system exists to hold.
- **Deterministic policy engine as pure TypeScript functions**, not prompt text — testable, reviewable, and immune to the model "forgetting" a rule.
- **Graceful degradation everywhere** — no Bedrock credentials, no vector index, a database hiccup: each degrades to a narrower but still-correct behavior and says so, rather than crashing or lying.
- **Next.js App Router, server components by default** — data fetching stays server-side; the only client components are the interactive console and approval buttons.

## Future roadmap

- Multi-agent delegation for research-heavy sub-requests (CockroachDB Managed Agents multiagent pattern).
- Memory consolidation — periodically summarizing many low-importance `event` memories into a single `preference`.
- Slack/email intake, so requests arrive without a human opening the dashboard.
- Per-team policy overrides layered on top of the organizational defaults.

---

## Project structure

```
memento/
├── db/migrations/          SQL migrations (001 core schema, 002-003 vector index, optional)
├── src/
│   ├── app/                Next.js App Router — pages + API routes
│   ├── components/         Server + client UI components
│   └── lib/
│       ├── agent/          Runtime, tools, prompt, request parser
│       ├── ai/             Bedrock embeddings + local fallback
│       ├── db/             pg client, repositories, types
│       ├── memory/         remember() / recall() — the memory service
│       ├── policy/         Deterministic rules + reconciliation engine
│       └── seed/           Northstar Labs seed data
├── scripts/                 db:migrate / seed / reset / health / demo / mcp:config
└── docs/                    Deployment and MCP setup guides
```

import { heading, info, loadEnv, ok, warn, fail } from "./_env.ts";

loadEnv();

// Dynamic imports so loadEnv() has already populated process.env before any
// module reads configuration.
const { closePool, query } = await import("@/lib/db/client");
const { embed } = await import("@/lib/ai/embeddings");
const { toVectorLiteral } = await import("@/lib/db/repositories/memories");
const { MEMORIES, POLICIES, REQUESTS, RESOURCES, TEAMS, USERS } = await import(
  "@/lib/seed/northstar"
);

/**
 * Seeds Northstar Labs.
 *
 * Idempotent: it clears the application tables first, so `npm run db:seed` twice
 * produces the same database. Deletion order follows the foreign keys.
 *
 * The one moving part is the temporary allocation on gpu-a100-03, which is
 * pinned to expire *tomorrow* relative to whenever the seed runs. The demo
 * depends on that being true today, not on a date that was true when the seed
 * data was written.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * DAY_MS);
const daysAhead = (n: number) => new Date(now + n * DAY_MS);

/**
 * A seed row that references a key we never inserted is a bug in the seed data,
 * not a nullable column — fail loudly rather than writing a NULL foreign key.
 */
function required(map: Map<string, string>, key: string, what: string): string {
  const value = map.get(key);
  if (!value) throw new Error(`Seed data references an unknown ${what}: "${key}"`);
  return value;
}

/** For genuinely optional references. */
function optional(map: Map<string, string>, key: string | null): string | null {
  return key ? (map.get(key) ?? null) : null;
}

async function clear(): Promise<void> {
  // Children first — the schema uses RESTRICT on users/teams deliberately.
  const tables = [
    "audit_events",
    "agent_memories",
    "approvals",
    "agent_decisions",
    "agent_sessions",
    "request_events",
    "resource_allocations",
    "requests",
    "resources",
    "users",
    "teams",
  ];
  for (const table of tables) {
    await query(`DELETE FROM ${table}`);
  }
}

async function main(): Promise<void> {
  heading("Seeding Northstar Labs");

  await clear();
  info("Cleared existing application data");

  // --- Teams and users -----------------------------------------------------
  const teamIds = new Map<string, string>();
  for (const team of TEAMS) {
    const rows = await query<{ id: string }>(
      `INSERT INTO teams (key, name, description, monthly_budget_usd, monthly_spend_usd, gpu_cap)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        team.key,
        team.name,
        team.description,
        team.monthlyBudgetUsd,
        team.monthlySpendUsd,
        team.gpuCap,
      ],
    );
    teamIds.set(team.key, rows[0]!.id);
  }
  ok(`${TEAMS.length} teams`);

  const userIds = new Map<string, string>();
  for (const user of USERS) {
    const teamId = teamIds.get(user.teamKey);
    if (!teamId) throw new Error(`Unknown team ${user.teamKey} for ${user.email}`);
    const rows = await query<{ id: string }>(
      `INSERT INTO users (email, name, title, team_id, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user.email, user.name, user.title, teamId, user.role],
    );
    userIds.set(user.email, rows[0]!.id);
  }
  ok(`${USERS.length} people`);

  // --- Resources -----------------------------------------------------------
  const resourceIds = new Map<string, string>();
  for (const resource of RESOURCES) {
    const ownerTeamId = resource.ownerTeamKey
      ? (teamIds.get(resource.ownerTeamKey) ?? null)
      : null;
    const rows = await query<{ id: string }>(
      `INSERT INTO resources
         (key, name, kind, specification, vendor, monthly_cost_usd,
          owner_team_id, status, utilization_percent, region)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        resource.key,
        resource.name,
        resource.kind,
        JSON.stringify(resource.specification),
        resource.vendor,
        resource.monthlyCostUsd,
        ownerTeamId,
        resource.status,
        resource.utilizationPercent,
        resource.region,
      ],
    );
    resourceIds.set(resource.key, rows[0]!.id);
  }
  ok(`${RESOURCES.length} resources`);

  // --- Policies ------------------------------------------------------------
  for (const policy of POLICIES) {
    await query(
      `INSERT INTO policies (key, name, description, category, severity, effect, rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        policy.key,
        policy.name,
        policy.description,
        policy.category,
        policy.severity,
        policy.effect,
        JSON.stringify(policy.rule),
      ],
    );
  }
  ok(`${POLICIES.length} policies`);

  // --- Requests, timeline events, decisions --------------------------------
  const policyByKey = new Map(POLICIES.map((p) => [p.key, p]));
  const requestIds = new Map<string, string>();
  const decisionIds = new Map<string, string>();

  for (const request of REQUESTS) {
    const requesterId = userIds.get(request.requesterEmail);
    if (!requesterId) throw new Error(`Unknown requester ${request.requesterEmail}`);

    const requester = USERS.find((u) => u.email === request.requesterEmail)!;
    const teamId = teamIds.get(requester.teamKey)!;
    const createdAt = daysAgo(request.daysAgo);
    const resolved = ["approved", "rejected", "fulfilled", "withdrawn"].includes(
      request.status,
    );

    const rows = await query<{ id: string }>(
      `INSERT INTO requests
         (reference, requester_id, team_id, title, body, request_type, resource_kind,
          quantity, estimated_monthly_cost_usd, vendor, environment, duration_days,
          status, created_at, updated_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15) RETURNING id`,
      [
        request.reference,
        requesterId,
        teamId,
        request.title,
        request.body,
        request.requestType,
        request.resourceKind,
        request.quantity,
        request.estimatedMonthlyCostUsd,
        request.vendor,
        request.environment,
        request.durationDays,
        request.status,
        createdAt,
        resolved ? daysAgo(request.daysAgo - 0.05) : null,
      ],
    );
    const requestId = rows[0]!.id;
    requestIds.set(request.reference, requestId);

    await query(
      `INSERT INTO request_events (request_id, event_type, actor_type, actor_id, summary, payload, created_at)
       VALUES ($1, 'created', 'user', $2, $3, $4, $5)`,
      [
        requestId,
        requesterId,
        `Request submitted: ${request.title}`,
        JSON.stringify({ body: request.body }),
        createdAt,
      ],
    );

    if (!request.decision) continue;

    const triggered = request.decision.policyKeys.map((key) => {
      const policy = policyByKey.get(key);
      return {
        key,
        name: policy?.name ?? key,
        severity: policy?.severity ?? "hard",
        effect: policy?.effect ?? "advisory",
        verdict: request.decision!.decision,
        explanation: policy?.description ?? "",
      };
    });

    const decisionRows = await query<{ id: string }>(
      `INSERT INTO agent_decisions
         (request_id, decision, rationale, next_action, evidence, policies_triggered,
          memories_used, tools_invoked, actions_taken, structured_facts_count,
          semantic_memories_count, confidence, reasoning_provider, model, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'[]'::JSONB,'[]'::JSONB,'[]'::JSONB,$7,$8,'high','bedrock',$9,$10)
       RETURNING id`,
      [
        requestId,
        request.decision.decision,
        request.decision.rationale,
        request.decision.nextAction,
        JSON.stringify(
          triggered.map((t) => ({
            label: t.name,
            detail: t.explanation,
            source: "policy",
          })),
        ),
        JSON.stringify(triggered),
        3,
        2,
        process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-sonnet-5",
        daysAgo(request.daysAgo - 0.02),
      ],
    );
    decisionIds.set(request.reference, decisionRows[0]!.id);

    await query(
      `INSERT INTO request_events (request_id, event_type, actor_type, summary, payload, created_at)
       VALUES ($1, 'agent_decision', 'agent', $2, $3, $4)`,
      [
        requestId,
        `${request.decision.decision}: ${request.decision.rationale}`,
        JSON.stringify({ next_action: request.decision.nextAction }),
        daysAgo(request.daysAgo - 0.02),
      ],
    );

    if (
      request.decision.decision === "REQUEST_APPROVAL" ||
      request.decision.decision === "FLAG_FOR_REVIEW"
    ) {
      const pending = request.status === "under_review";
      await query(
        `INSERT INTO approvals
           (request_id, decision_id, required_role, reason, status, approver_id, resolved_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          requestId,
          decisionRows[0]!.id,
          request.decision.decision === "FLAG_FOR_REVIEW" ? "admin" : "lead",
          request.decision.nextAction,
          pending ? "pending" : "approved",
          pending ? null : required(userIds, "sarah.wilson@northstarlabs.io", "user"),
          pending ? null : daysAgo(request.daysAgo - 0.5),
          daysAgo(request.daysAgo - 0.02),
        ],
      );
    }
  }
  ok(`${REQUESTS.length} historical requests with decisions`);

  // --- Allocations ---------------------------------------------------------
  // gpu-a100-03 is the load-bearing one: a temporary allocation to Alex Chen
  // that expires TOMORROW, whenever "today" happens to be.
  const aiResearch = teamIds.get("ai-research")!;
  const engineering = teamIds.get("engineering")!;
  const alex = userIds.get("alex.chen@northstarlabs.io")!;

  const allocations: Array<{
    resourceKey: string;
    teamId: string;
    userId: string | null;
    requestRef: string | null;
    type: "permanent" | "temporary";
    purpose: string;
    startsAt: Date;
    expiresAt: Date | null;
  }> = [
    {
      resourceKey: "gpu-a100-01",
      teamId: aiResearch,
      userId: null,
      requestRef: null,
      type: "permanent",
      purpose: "Foundation model pretraining",
      startsAt: daysAgo(180),
      expiresAt: null,
    },
    {
      resourceKey: "gpu-a100-03",
      teamId: aiResearch,
      userId: alex,
      requestRef: "REQ-1007",
      type: "temporary",
      purpose: "computer vision experiment for the object detection paper",
      startsAt: daysAgo(6),
      expiresAt: daysAhead(1),
    },
    {
      resourceKey: "gpu-h100-01",
      teamId: engineering,
      userId: null,
      requestRef: null,
      type: "permanent",
      purpose: "Inference benchmarking",
      startsAt: daysAgo(120),
      expiresAt: null,
    },
    {
      resourceKey: "ec2-ml-train-01",
      teamId: aiResearch,
      userId: null,
      requestRef: null,
      type: "permanent",
      purpose: "Training orchestration",
      startsAt: daysAgo(200),
      expiresAt: null,
    },
    {
      resourceKey: "ec2-api-prod-01",
      teamId: engineering,
      userId: null,
      requestRef: null,
      type: "permanent",
      purpose: "Production API",
      startsAt: daysAgo(300),
      expiresAt: null,
    },
    {
      resourceKey: "ec2-api-prod-02",
      teamId: engineering,
      userId: null,
      requestRef: null,
      type: "permanent",
      purpose: "Production API",
      startsAt: daysAgo(300),
      expiresAt: null,
    },
  ];

  for (const allocation of allocations) {
    await query(
      `INSERT INTO resource_allocations
         (resource_id, team_id, user_id, request_id, allocation_type, purpose, starts_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        required(resourceIds, allocation.resourceKey, "resource"),
        allocation.teamId,
        allocation.userId,
        optional(requestIds, allocation.requestRef),
        allocation.type,
        allocation.purpose,
        allocation.startsAt,
        allocation.expiresAt,
      ],
    );
  }
  ok(`${allocations.length} resource allocations`);

  // --- Semantic memory -----------------------------------------------------
  heading("Embedding semantic memory");

  let embeddedCount = 0;
  let providerLabel = "unknown";

  for (const memory of MEMORIES) {
    const { vector, model, provider } = await embed(memory.content);
    providerLabel = provider;
    if (vector.some((v) => v !== 0)) embeddedCount += 1;

    await query(
      `INSERT INTO agent_memories
         (content, summary, memory_type, importance, embedding, embedding_model,
          source_kind, source_request_id, source_decision_id, subject_team_id,
          subject_user_id, subject_resource_id, metadata, occurred_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5::VECTOR,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$14)`,
      [
        memory.content,
        memory.summary,
        memory.memoryType,
        memory.importance,
        toVectorLiteral(vector),
        model,
        memory.sourceRequestRef ? "request" : "system",
        optional(requestIds, memory.sourceRequestRef),
        optional(decisionIds, memory.sourceRequestRef),
        optional(teamIds, memory.subjectTeamKey),
        optional(userIds, memory.subjectUserEmail),
        optional(resourceIds, memory.subjectResourceKey),
        JSON.stringify({ seeded: true }),
        daysAgo(memory.daysAgo),
        memory.expiresInDays === null ? null : daysAhead(memory.expiresInDays),
      ],
    );
  }

  ok(`${MEMORIES.length} memories embedded with ${providerLabel}`);
  if (providerLabel === "local-lexical") {
    warn(
      "Embeddings came from the local lexical fallback because Amazon Bedrock was not reachable. " +
        "Semantic retrieval will match on shared vocabulary rather than meaning. Configure AWS " +
        "credentials and re-run `npm run db:seed` for true semantic memory.",
    );
  }
  if (embeddedCount !== MEMORIES.length) {
    warn(`${MEMORIES.length - embeddedCount} memories stored without a usable vector`);
  }

  // --- Summary -------------------------------------------------------------
  const summary = await query<{ label: string; count: number }>(
    `SELECT 'teams' AS label, count(*)::INT AS count FROM teams
     UNION ALL SELECT 'users', count(*)::INT FROM users
     UNION ALL SELECT 'resources', count(*)::INT FROM resources
     UNION ALL SELECT 'allocations', count(*)::INT FROM resource_allocations
     UNION ALL SELECT 'policies', count(*)::INT FROM policies
     UNION ALL SELECT 'requests', count(*)::INT FROM requests
     UNION ALL SELECT 'decisions', count(*)::INT FROM agent_decisions
     UNION ALL SELECT 'memories', count(*)::INT FROM agent_memories`,
  );

  heading("Northstar Labs is ready");
  for (const row of summary) {
    info(`${row.count.toString().padStart(3)} ${row.label}`);
  }

  console.log("");
  info("Try this on the Agent page, as Alex Chen:");
  console.log(
    `      "I need another GPU for my computer vision experiment."\n`,
  );
}

main()
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());

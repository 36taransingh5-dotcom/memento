import { listAuditEvents, recordAuditEvent } from "@/lib/db/repositories/audit";
import { getTeamById, getUserById } from "@/lib/db/repositories/organization";
import { listPolicies } from "@/lib/db/repositories/policies";
import {
  allocateResource,
  findExpiringAllocations,
  findReusableResources,
  getResourceById,
  getTeamResourceUsage,
  listTeamResources,
} from "@/lib/db/repositories/resources";
import {
  addRequestEvent,
  createRequest,
  getRequestById,
  getRequestHistory,
} from "@/lib/db/repositories/requests";
import type {
  Decision,
  EvidenceItem,
  RequestType,
  ResourceKind,
} from "@/lib/db/types";
import { DECISIONS } from "@/lib/db/types";
import { recall } from "@/lib/memory/service";
import { remember } from "@/lib/memory/service";
import { buildPolicyContext } from "@/lib/policy/context";
import { evaluatePolicies } from "@/lib/policy/engine";
import { kindLabel } from "@/lib/policy/rules";
import type {
  AgentToolDefinition,
  ToolResult,
} from "@/lib/agent/types";

/**
 * The agent's tool surface.
 *
 * Three deliberate design choices:
 *
 *  - `evaluate_policy` is mandatory before `record_decision`. The model cannot
 *    reason its way to an organizational rule; it must ask the engine.
 *  - `record_decision` is the only terminal tool. Approving, rejecting and
 *    escalating are *effects* the runtime performs after reconciling the
 *    model's proposal with the deterministic verdict — they are not exposed as
 *    model-callable tools, because a model that can call `approve_request`
 *    directly can bypass the policy engine, and that is the one invariant this
 *    system exists to hold.
 *  - `reserve_existing_resource` IS model-callable, but refuses to run until
 *    policy has been evaluated, and refuses outright on a hard REJECT.
 */

const RESOURCE_KINDS: ResourceKind[] = [
  "gpu",
  "cloud_instance",
  "saas_license",
  "production_service",
];

const REQUEST_TYPES: RequestType[] = [
  "resource_provision",
  "resource_reuse",
  "saas_license",
  "service_addition",
  "access",
  "other",
];

// --- input coercion ---------------------------------------------------------

function str(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function int(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function decimal(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function oneOf<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = str(input, key);
  return value && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function fail(summary: string): ToolResult {
  return { summary, data: { error: summary }, isError: true };
}

// --- tools ------------------------------------------------------------------

const createRequestTool: AgentToolDefinition = {
  name: "create_request",
  description:
    "Turn the requester's free-text message into a structured operational request, and persist it. " +
    "Call this FIRST, before any investigation, whenever the conversation does not already reference " +
    "an existing request. Extract every field you can from what the requester actually said — do not " +
    "invent a cost, vendor, or environment they did not mention; leave those null so the policy engine " +
    "can ask for them.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short imperative summary, e.g. 'Provision an additional A100 GPU'." },
      request_type: { type: "string", enum: REQUEST_TYPES, description: "Best-fit category for the ask." },
      resource_kind: {
        type: ["string", "null"],
        enum: [...RESOURCE_KINDS, null],
        description: "The kind of resource involved, or null if the request is not about a resource.",
      },
      quantity: { type: "integer", description: "How many units are requested. Default 1." },
      estimated_monthly_cost_usd: {
        type: ["number", "null"],
        description: "Monthly cost in USD if the requester stated or implied one; null otherwise.",
      },
      vendor: { type: ["string", "null"], description: "Named vendor, e.g. 'New Relic'. Null if unspecified." },
      environment: {
        type: ["string", "null"],
        enum: ["production", "staging", "development", null],
        description: "Target environment if stated; null otherwise.",
      },
      duration_days: {
        type: ["integer", "null"],
        description: "Requested duration for a temporary allocation; null if permanent or unstated.",
      },
    },
    required: ["title", "request_type"],
    additionalProperties: false,
  },
  async handler(input, state) {
    if (state.requestId) {
      return fail(
        `Request ${state.requestFacts?.reference ?? state.requestId} already exists for this session — investigate it instead of creating another.`,
      );
    }

    const title = str(input, "title");
    const requestType = oneOf(input, "request_type", REQUEST_TYPES);
    if (!title || !requestType) {
      return fail("create_request requires a non-empty title and a valid request_type.");
    }

    const created = await createRequest({
      requesterId: state.requester.id,
      teamId: state.requester.team_id,
      title,
      body: state.requestFacts?.body ?? title,
      requestType,
      resourceKind: oneOf(input, "resource_kind", RESOURCE_KINDS),
      quantity: int(input, "quantity") ?? 1,
      estimatedMonthlyCostUsd: decimal(input, "estimated_monthly_cost_usd"),
      vendor: str(input, "vendor"),
      environment: str(input, "environment"),
      durationDays: int(input, "duration_days"),
    });

    state.requestId = created.id;
    state.requestFacts = {
      id: created.id,
      reference: created.reference,
      title: created.title,
      body: created.body,
      requestType: created.request_type,
      resourceKind: created.resource_kind,
      quantity: created.quantity,
      estimatedMonthlyCostUsd: created.estimated_monthly_cost_usd,
      vendor: created.vendor,
      environment: created.environment,
      durationDays: created.duration_days,
    };

    return {
      summary: `Created ${created.reference}: ${created.title}`,
      data: {
        request_id: created.id,
        reference: created.reference,
        status: created.status,
        parsed: state.requestFacts,
      },
    };
  },
};

const getUserTool: AgentToolDefinition = {
  name: "get_user",
  description:
    "Look up a person: their team, job title, and approval role. Call this to establish who is asking " +
    "and what authority they hold. With no user_id, returns the current requester.",
  input_schema: {
    type: "object",
    properties: {
      user_id: { type: ["string", "null"], description: "UUID of a user, or null for the current requester." },
    },
    additionalProperties: false,
  },
  async handler(input, state) {
    const userId = str(input, "user_id") ?? state.requester.id;
    const user = await getUserById(userId);
    if (!user) return fail(`No user with id ${userId}`);

    state.structuredEvidence.push({
      label: `Requester: ${user.name} (${user.team_name})`,
      detail: `${user.title || "Team member"}, approval role "${user.role}".`,
      source: "structured",
    });
    state.structuredFactsCount += 1;

    return {
      summary: `${user.name} — ${user.title || "member"} on ${user.team_name}`,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
        role: user.role,
        team: { id: user.team_id, name: user.team_name, key: user.team_key },
      },
    };
  },
};

const getTeamTool: AgentToolDefinition = {
  name: "get_team",
  description:
    "Retrieve a team's budget, current spend, resource caps, and a per-kind breakdown of what it already " +
    "holds. Call this before making any decision with a cost or capacity dimension. With no team_id, " +
    "returns the requester's team.",
  input_schema: {
    type: "object",
    properties: {
      team_id: { type: ["string", "null"], description: "UUID of a team, or null for the requester's team." },
    },
    additionalProperties: false,
  },
  async handler(input, state) {
    const teamId = str(input, "team_id") ?? state.requester.team_id;
    const team = await getTeamById(teamId);
    if (!team) return fail(`No team with id ${teamId}`);

    const usage = await getTeamResourceUsage(teamId);
    const headroom = team.monthly_budget_usd - team.monthly_spend_usd;

    state.structuredEvidence.push({
      label: `${team.name} budget headroom: $${headroom.toLocaleString()}/mo`,
      detail: `$${team.monthly_spend_usd.toLocaleString()} spent of $${team.monthly_budget_usd.toLocaleString()}.`,
      source: "structured",
    });
    state.structuredFactsCount += 1;

    const gpu = usage.find((u) => u.kind === "gpu");
    if (gpu) {
      state.structuredEvidence.push({
        label: `${team.name} holds ${gpu.total} GPUs — ${gpu.in_use} in use, ${gpu.idle} idle`,
        detail: `Team GPU cap is ${team.gpu_cap}.`,
        source: "structured",
      });
      state.structuredFactsCount += 1;
    }

    return {
      summary: `${team.name}: $${headroom.toLocaleString()} headroom, ${usage.length} resource kinds held`,
      data: {
        id: team.id,
        name: team.name,
        monthly_budget_usd: team.monthly_budget_usd,
        monthly_spend_usd: team.monthly_spend_usd,
        budget_headroom_usd: headroom,
        gpu_cap: team.gpu_cap,
        resource_usage: usage,
      },
    };
  },
};

const getResourcesTool: AgentToolDefinition = {
  name: "get_resources",
  description:
    "List the resources a team owns, with live status (in_use / idle / available), utilization, cost, and " +
    "who currently holds each one. Use this to see what the team already has before considering anything new.",
  input_schema: {
    type: "object",
    properties: {
      team_id: { type: ["string", "null"], description: "UUID of a team, or null for the requester's team." },
      resource_kind: {
        type: ["string", "null"],
        enum: [...RESOURCE_KINDS, null],
        description: "Restrict to one kind, or null for all kinds.",
      },
    },
    additionalProperties: false,
  },
  async handler(input, state) {
    const teamId = str(input, "team_id") ?? state.requester.team_id;
    const kind = oneOf(input, "resource_kind", RESOURCE_KINDS);
    const resources = await listTeamResources(teamId, kind ?? undefined);

    return {
      summary: `${resources.length} resource${resources.length === 1 ? "" : "s"}${kind ? ` of kind ${kind}` : ""}`,
      data: resources.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        kind: r.kind,
        status: r.status,
        utilization_percent: r.utilization_percent,
        monthly_cost_usd: r.monthly_cost_usd,
        vendor: r.vendor,
        held_by: r.allocation_holder,
        allocation_type: r.allocation_type,
        allocation_expires_at: r.allocation_expires_at,
        purpose: r.allocation_purpose,
      })),
    };
  },
};

const checkAvailabilityTool: AgentToolDefinition = {
  name: "check_availability",
  description:
    "Determine whether existing capacity can satisfy the request without provisioning anything new. " +
    "Returns idle resources the team already owns, unassigned resources in the shared pool, and temporary " +
    "allocations that are about to expire and return capacity. ALWAYS call this before deciding on any " +
    "request that would provision, buy, or add a resource — it is the difference between an agent that " +
    "spends money and one that notices the organization already has what it needs.",
  input_schema: {
    type: "object",
    properties: {
      resource_kind: { type: "string", enum: RESOURCE_KINDS, description: "The kind of resource requested." },
      expiring_within_days: {
        type: ["integer", "null"],
        description: "Window for upcoming allocation expiries. Default 14.",
      },
    },
    required: ["resource_kind"],
    additionalProperties: false,
  },
  async handler(input, state) {
    const kind = oneOf(input, "resource_kind", RESOURCE_KINDS);
    if (!kind) return fail(`resource_kind must be one of ${RESOURCE_KINDS.join(", ")}`);

    const withinDays = int(input, "expiring_within_days") ?? 14;
    const teamId = state.requester.team_id;

    const [reusable, expiring] = await Promise.all([
      findReusableResources(teamId, kind),
      findExpiringAllocations(teamId, withinDays),
    ]);

    const relevantExpiring = expiring.filter((a) => a.resource_kind === kind);

    if (reusable.length > 0) {
      const owned = reusable.filter((r) => r.owner_team_id === teamId);
      state.structuredEvidence.push({
        label: `${reusable.length} reusable ${kindLabel(kind, reusable.length)} found`,
        detail:
          owned.length > 0
            ? `${owned.length} idle and already owned by the team: ${owned.map((r) => r.name).join(", ")}.`
            : `${reusable.length} unassigned in the shared pool.`,
        source: "structured",
      });
      state.structuredFactsCount += 1;
    }

    for (const allocation of relevantExpiring) {
      state.structuredEvidence.push({
        label: `${allocation.resource_name} returns to the pool on ${allocation.expires_at ? new Date(allocation.expires_at).toISOString().slice(0, 10) : "an unknown date"}`,
        detail: `Temporary allocation${allocation.holder_name ? ` held by ${allocation.holder_name}` : ""}${allocation.purpose ? ` for ${allocation.purpose}` : ""}.`,
        source: "structured",
      });
      state.structuredFactsCount += 1;
    }

    return {
      summary:
        reusable.length === 0 && relevantExpiring.length === 0
          ? `No reusable ${kind} capacity and none expiring within ${withinDays} days`
          : `${reusable.length} reusable, ${relevantExpiring.length} expiring within ${withinDays} days`,
      data: {
        reusable_resources: reusable.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          status: r.status,
          utilization_percent: r.utilization_percent,
          owned_by_requesting_team: r.owner_team_id === teamId,
          monthly_cost_usd: r.monthly_cost_usd,
        })),
        expiring_allocations: relevantExpiring.map((a) => ({
          allocation_id: a.id,
          resource_id: a.resource_id,
          resource_name: a.resource_name,
          holder: a.holder_name,
          purpose: a.purpose,
          expires_at: a.expires_at,
        })),
      },
    };
  },
};

const getRequestHistoryTool: AgentToolDefinition = {
  name: "get_request_history",
  description:
    "Retrieve exact past requests and how they were decided, for this requester or their whole team. This " +
    "is precise structured recall — use it to check whether the organization has already answered a version " +
    "of this question. Complements search_memory, which finds context nobody thought to index.",
  input_schema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["requester", "team"],
        description: "Whose history to search. Default 'team'.",
      },
      resource_kind: {
        type: ["string", "null"],
        enum: [...RESOURCE_KINDS, null],
        description: "Restrict to one resource kind, or null for all.",
      },
      lookback_days: { type: ["integer", "null"], description: "How far back to look. Default 90." },
    },
    additionalProperties: false,
  },
  async handler(input, state) {
    const scope = oneOf(input, "scope", ["requester", "team"] as const) ?? "team";
    const history = await getRequestHistory({
      userId: scope === "requester" ? state.requester.id : undefined,
      teamId: scope === "team" ? state.requester.team_id : undefined,
      resourceKind: oneOf(input, "resource_kind", RESOURCE_KINDS),
      lookbackDays: int(input, "lookback_days") ?? 90,
      limit: 15,
    });

    const decided = history.filter((r) => r.latest_decision !== null);
    if (decided.length > 0) {
      state.structuredFactsCount += decided.length;
    }

    return {
      summary: `${history.length} prior request${history.length === 1 ? "" : "s"} (${decided.length} decided)`,
      data: history.map((r) => ({
        id: r.id,
        reference: r.reference,
        title: r.title,
        requester: r.requester_name,
        status: r.status,
        decision: r.latest_decision,
        resource_kind: r.resource_kind,
        quantity: r.quantity,
        vendor: r.vendor,
        created_at: r.created_at,
      })),
    };
  },
};

const searchMemoryTool: AgentToolDefinition = {
  name: "search_memory",
  description:
    "Semantic search across Memento's long-term organizational memory — past decisions and their reasons, " +
    "outcomes, vendor preferences, policy exceptions, and expirations. Query it in natural language " +
    "describing the situation, not with keywords. Call this on EVERY request: it surfaces the context that " +
    "does not appear in any structured table, such as why a similar request was refused last quarter.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of what you want to remember about, e.g. 'GPU allocation for computer vision experiments on the AI Research team'.",
      },
      limit: { type: ["integer", "null"], description: "Maximum memories to return. Default 5, max 10." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(input, state) {
    const query = str(input, "query");
    if (!query) return fail("search_memory requires a non-empty natural-language query.");

    const limit = Math.min(int(input, "limit") ?? 5, 10);
    const results = await recall(query, {
      limit,
      teamId: state.requester.team_id,
      sessionId: state.sessionId,
      requestId: state.requestId,
    });

    for (const memory of results) {
      if (!state.retrievedMemories.some((m) => m.id === memory.id)) {
        state.retrievedMemories.push(memory);
      }
    }

    return {
      summary:
        results.length === 0
          ? "No relevant memories above the similarity threshold"
          : `${results.length} memor${results.length === 1 ? "y" : "ies"} recalled (top similarity ${results[0]?.similarity.toFixed(3)})`,
      data: results.map((m) => ({
        id: m.id,
        summary: m.summary,
        content: m.content,
        memory_type: m.memory_type,
        similarity: Number(m.similarity.toFixed(4)),
        occurred_at: m.occurred_at,
        about_team: m.team_name,
        about_person: m.user_name,
        about_resource: m.resource_name,
        source_request: m.source_request_reference,
      })),
    };
  },
};

const getPoliciesTool: AgentToolDefinition = {
  name: "get_policies",
  description:
    "Read the organization's written policies. Use this to explain a rule to the requester in their own " +
    "terms. Do NOT use it to decide whether a rule applies — call evaluate_policy for that, which runs the " +
    "rules deterministically against the real data.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: ["string", "null"],
        enum: ["resource", "budget", "vendor", "security", "process", null],
        description: "Restrict to one category, or null for all.",
      },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const category = oneOf(input, "category", [
      "resource",
      "budget",
      "vendor",
      "security",
      "process",
    ] as const);
    const policies = await listPolicies({
      enabledOnly: true,
      category: category ?? undefined,
    });

    return {
      summary: `${policies.length} active polic${policies.length === 1 ? "y" : "ies"}`,
      data: policies.map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        category: p.category,
        severity: p.severity,
        effect: p.effect,
      })),
    };
  },
};

const evaluatePolicyTool: AgentToolDefinition = {
  name: "evaluate_policy",
  description:
    "Run every enabled organizational policy deterministically against this request and the live data, and " +
    "return the verdicts. You MUST call this before record_decision. The verdict it returns is binding: a " +
    "policy marked 'hard' cannot be overridden by your judgement, and attempting to record a laxer decision " +
    "will be corrected automatically. Call it after you have gathered context, so the rules see complete data.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_input, state) {
    if (!state.requestFacts) {
      return fail("No request exists yet — call create_request before evaluate_policy.");
    }

    const [context, policies] = await Promise.all([
      buildPolicyContext({
        request: state.requestFacts,
        requester: state.requester,
      }),
      listPolicies({ enabledOnly: true }),
    ]);

    const evaluation = evaluatePolicies(context, policies);
    state.policyEvaluation = evaluation;

    await recordAuditEvent({
      sessionId: state.sessionId,
      requestId: state.requestId,
      action: "policy.evaluated",
      parameters: {
        policies_evaluated: evaluation.evaluatedKeys.length,
        triggered: evaluation.triggered.map((t) => t.key),
      },
      resultSummary: evaluation.verdict
        ? `Deterministic verdict: ${evaluation.verdict}${evaluation.mandatory ? " (binding)" : " (advisory)"}`
        : "No policy mandated a decision",
    });

    return {
      summary: evaluation.verdict
        ? `${evaluation.triggered.length} polic${evaluation.triggered.length === 1 ? "y" : "ies"} triggered — verdict ${evaluation.verdict}${evaluation.mandatory ? " (binding)" : " (advisory)"}`
        : `${evaluation.triggered.length} triggered, none mandating a decision`,
      data: {
        required_decision: evaluation.verdict,
        binding: evaluation.mandatory,
        recommended_next_action: evaluation.nextAction,
        triggered_policies: evaluation.triggered,
        evidence: evaluation.evidence,
      },
    };
  },
};

const reserveExistingResourceTool: AgentToolDefinition = {
  name: "reserve_existing_resource",
  description:
    "Assign an existing idle resource to the requester instead of provisioning something new. This performs " +
    "a real allocation. Call it only after the requester has agreed to reuse, or when reuse is the " +
    "unambiguous outcome of the request. Refuses if policy has not been evaluated or a hard policy rejects " +
    "the request.",
  input_schema: {
    type: "object",
    properties: {
      resource_id: { type: "string", description: "UUID of the resource to allocate." },
      purpose: { type: "string", description: "What the requester will use it for." },
      duration_days: {
        type: ["integer", "null"],
        description: "Days for a temporary allocation, or null for permanent.",
      },
    },
    required: ["resource_id", "purpose"],
    additionalProperties: false,
  },
  async handler(input, state) {
    if (!state.policyEvaluation) {
      return fail("Call evaluate_policy before allocating a resource.");
    }
    if (state.policyEvaluation.verdict === "REJECT" && state.policyEvaluation.mandatory) {
      return fail("A hard policy rejects this request — allocation refused.");
    }

    const resourceId = str(input, "resource_id");
    const purpose = str(input, "purpose");
    if (!resourceId || !purpose) {
      return fail("reserve_existing_resource requires resource_id and purpose.");
    }

    const resource = await getResourceById(resourceId);
    if (!resource) return fail(`No resource with id ${resourceId}`);
    if (resource.status !== "idle" && resource.status !== "available") {
      return fail(
        `${resource.name} is ${resource.status}, not available for reuse. Pick an idle resource.`,
      );
    }

    const durationDays = int(input, "duration_days");
    const allocation = await allocateResource({
      resourceId,
      teamId: state.requester.team_id,
      userId: state.requester.id,
      requestId: state.requestId,
      allocationType: durationDays ? "temporary" : "permanent",
      purpose,
      durationDays,
    });

    state.actions.push({
      action: "resource.reused",
      detail: `Allocated ${resource.name} to ${state.requester.name} for ${purpose}${
        durationDays ? ` (${durationDays} days)` : ""
      } instead of provisioning new capacity.`,
      entity_id: allocation.id,
    });

    if (state.requestId) {
      await addRequestEvent({
        requestId: state.requestId,
        eventType: "fulfilled",
        actorType: "agent",
        summary: `Reused existing resource ${resource.name} rather than provisioning new capacity.`,
        payload: { allocation_id: allocation.id, resource_id: resourceId },
      });
    }

    await recordAuditEvent({
      sessionId: state.sessionId,
      requestId: state.requestId,
      action: "action.executed",
      toolName: "reserve_existing_resource",
      parameters: { resource_id: resourceId, purpose, duration_days: durationDays },
      resultSummary: `Allocated ${resource.name} to ${state.requester.name}`,
    });

    return {
      summary: `Allocated ${resource.name} to ${state.requester.name}`,
      data: {
        allocation_id: allocation.id,
        resource: { id: resource.id, name: resource.name, key: resource.key },
        expires_at: allocation.expires_at,
      },
    };
  },
};

const createMemoryTool: AgentToolDefinition = {
  name: "create_memory",
  description:
    "Store something worth remembering for future decisions: a preference the requester expressed, a " +
    "constraint you discovered, or an outcome that will matter later. Write the content so it still makes " +
    "sense a year from now with no surrounding context — name the team, the person, the resource, and the " +
    "date. Do NOT record the decision itself; that is stored automatically.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Self-contained memory text, one or two sentences, naming the specific people and things involved.",
      },
      summary: { type: "string", description: "Short label for the memory list, under 80 characters." },
      memory_type: {
        type: "string",
        enum: ["outcome", "preference", "constraint", "policy_exception", "event", "expiration"],
        description: "What kind of memory this is.",
      },
      importance: { type: ["integer", "null"], description: "1 (trivial) to 5 (organization-shaping). Default 3." },
      resource_id: { type: ["string", "null"], description: "UUID of the resource this is about, if any." },
    },
    required: ["content", "summary", "memory_type"],
    additionalProperties: false,
  },
  async handler(input, state) {
    const content = str(input, "content");
    const summary = str(input, "summary");
    const memoryType = oneOf(input, "memory_type", [
      "outcome",
      "preference",
      "constraint",
      "policy_exception",
      "event",
      "expiration",
    ] as const);

    if (!content || !summary || !memoryType) {
      return fail("create_memory requires content, summary, and a valid memory_type.");
    }

    const memory = await remember({
      content,
      summary,
      memoryType,
      importance: Math.min(Math.max(int(input, "importance") ?? 3, 1), 5),
      sourceKind: "decision",
      sourceRequestId: state.requestId,
      subjectTeamId: state.requester.team_id,
      subjectUserId: state.requester.id,
      subjectResourceId: str(input, "resource_id"),
      sessionId: state.sessionId,
    });

    state.actions.push({
      action: "memory.created",
      detail: summary,
      entity_id: memory.id,
    });

    return {
      summary: `Stored memory: ${summary}`,
      data: { memory_id: memory.id, memory_type: memoryType },
    };
  },
};

const getAuditHistoryTool: AgentToolDefinition = {
  name: "get_audit_history",
  description:
    "Review what the agent has already done on this request — which tools ran, what they returned, and what " +
    "actions were taken. Useful when a request is revisited later, or to avoid repeating work.",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: ["integer", "null"], description: "Maximum events. Default 25." },
    },
    additionalProperties: false,
  },
  async handler(input, state) {
    const events = await listAuditEvents({
      requestId: state.requestId ?? undefined,
      limit: Math.min(int(input, "limit") ?? 25, 100),
    });

    return {
      summary: `${events.length} prior audit event${events.length === 1 ? "" : "s"}`,
      data: events.map((e) => ({
        action: e.action,
        tool: e.tool_name,
        result: e.result_summary,
        at: e.created_at,
        is_error: e.is_error,
      })),
    };
  },
};

const recordDecisionTool: AgentToolDefinition = {
  name: "record_decision",
  description:
    "Record your final decision. This ends your turn — call it exactly once, last, after evaluate_policy. " +
    "The rationale is read by the requester and by auditors: state what you concluded and the facts it rests " +
    "on, in two or three plain sentences. Do not narrate your process, restate the tools you called, or " +
    "include step-by-step reasoning. Cite concrete specifics — resource names, dates, prior request " +
    "references — rather than generalities.",
  input_schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: [...DECISIONS], description: "The outcome." },
      rationale: {
        type: "string",
        description: "Two or three sentences the requester will read, grounded in specific facts.",
      },
      next_action: {
        type: "string",
        description: "The single concrete next step, e.g. 'Ask Alex whether gpu-a100-03 can be used instead.'",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "How settled the decision is." },
      evidence: {
        type: "array",
        description: "The facts the decision rests on. Each is a short label plus a supporting detail.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            detail: { type: "string" },
          },
          required: ["label", "detail"],
          additionalProperties: false,
        },
      },
    },
    required: ["decision", "rationale", "next_action", "confidence"],
    additionalProperties: false,
  },
  async handler(input, state) {
    if (!state.policyEvaluation) {
      return fail(
        "evaluate_policy has not been called. Run it first — decisions must rest on evaluated policy, not judgement.",
      );
    }

    const decision = oneOf(input, "decision", DECISIONS);
    const rationale = str(input, "rationale");
    const nextAction = str(input, "next_action");
    if (!decision || !rationale || !nextAction) {
      return fail("record_decision requires decision, rationale, and next_action.");
    }

    const rawEvidence = Array.isArray(input["evidence"]) ? input["evidence"] : [];
    const evidence: EvidenceItem[] = rawEvidence
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((e) => ({
        label: typeof e["label"] === "string" ? e["label"] : "",
        detail: typeof e["detail"] === "string" ? e["detail"] : "",
        source: "computed" as const,
      }))
      .filter((e) => e.label !== "");

    state.proposal = {
      decision: decision as Decision,
      rationale,
      nextAction,
      evidence,
      confidence: oneOf(input, "confidence", ["high", "medium", "low"] as const) ?? "medium",
    };

    return {
      summary: `Proposed ${decision}`,
      data: { recorded: true, decision },
    };
  },
};

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  createRequestTool,
  getUserTool,
  getTeamTool,
  getResourcesTool,
  checkAvailabilityTool,
  getRequestHistoryTool,
  searchMemoryTool,
  getPoliciesTool,
  evaluatePolicyTool,
  reserveExistingResourceTool,
  createMemoryTool,
  getAuditHistoryTool,
  recordDecisionTool,
] as const;

export const TERMINAL_TOOL = "record_decision";

export function findTool(name: string): AgentToolDefinition | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

export { getRequestById };

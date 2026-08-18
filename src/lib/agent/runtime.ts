import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import {
  completeSession,
  createApproval,
  recordDecision,
  startSession,
} from "@/lib/db/repositories/decisions";
import { getUserById } from "@/lib/db/repositories/organization";
import { listPolicies } from "@/lib/db/repositories/policies";
import { findReusableResources } from "@/lib/db/repositories/resources";
import {
  addRequestEvent,
  createRequest,
  getRequestById,
  updateRequestStatus,
} from "@/lib/db/repositories/requests";
import type {
  Decision,
  EvidenceItem,
  ReasoningProvider,
  RequestStatus,
} from "@/lib/db/types";
import { env } from "@/lib/env";
import { remember, toMemoryReferences } from "@/lib/memory/service";
import { buildPolicyContext } from "@/lib/policy/context";
import { evaluatePolicies, reconcile } from "@/lib/policy/engine";
import { kindLabel } from "@/lib/policy/rules";
import type { RequestFacts } from "@/lib/policy/types";
import { parseRequest } from "@/lib/agent/parse";
import { DEGRADED_NOTICE, systemPrompt } from "@/lib/agent/prompt";
import { AGENT_TOOLS, findTool } from "@/lib/agent/tools";
import type {
  AgentRunResult,
  AgentRunState,
  PipelineStage,
  ToolResult,
} from "@/lib/agent/types";

/**
 * The agent loop.
 *
 * Amazon Bedrock supplies the reasoning; CockroachDB supplies the memory; the
 * deterministic policy engine supplies the authority. The loop is written by
 * hand rather than delegated to the SDK's tool runner because every tool call
 * needs its own timed audit row and its results need to flow into the decision
 * trace — the audit trail is a product surface here, not a debug log.
 */

const MAX_ITERATIONS = 12;
const MAX_TOKENS = 8000;

export interface RunAgentInput {
  userId: string;
  message: string;
  /** Continue an existing request rather than creating a new one. */
  requestId?: string | null;
  channel?: string;
}

export async function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
  const started = Date.now();

  const requester = await getUserById(input.userId);
  if (!requester) throw new Error(`No user with id ${input.userId}`);

  const bedrockConfigured = isBedrockConfigured();
  const session = await startSession({
    userId: requester.id,
    requestId: input.requestId ?? null,
    channel: input.channel ?? "web",
    model: bedrockConfigured ? env().BEDROCK_MODEL_ID : null,
    reasoningProvider: bedrockConfigured ? "bedrock" : "deterministic",
  });

  const state: AgentRunState = {
    sessionId: session.id,
    requester,
    requestId: input.requestId ?? null,
    requestFacts: null,
    invocations: [],
    retrievedMemories: [],
    structuredEvidence: [],
    actions: [],
    policyEvaluation: null,
    proposal: null,
    structuredFactsCount: 0,
  };

  // Seed the raw text so `create_request` keeps the requester's own words.
  if (state.requestId) {
    const existing = await getRequestById(state.requestId);
    if (existing) {
      state.requestFacts = toRequestFacts(existing);
    }
  } else {
    state.requestFacts = {
      id: null,
      reference: null,
      title: "",
      body: input.message,
      requestType: "other",
      resourceKind: null,
      quantity: 1,
      estimatedMonthlyCostUsd: null,
      vendor: null,
      environment: null,
      durationDays: null,
    };
  }

  await recordAuditEvent({
    sessionId: session.id,
    requestId: state.requestId,
    actorType: "user",
    actorId: requester.id,
    action: "session.started",
    parameters: { channel: input.channel ?? "web", message: input.message },
    resultSummary: `${requester.name} started an agent session`,
  });

  let provider: ReasoningProvider = "deterministic";
  let degradedReason: string | null = null;
  let usage = { input: 0, output: 0 };

  if (bedrockConfigured) {
    try {
      usage = await runBedrockLoop(state, input.message);
      provider = "bedrock";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!env().ALLOW_DEGRADED_AI) {
        await failSession(session.id, started, detail);
        throw err;
      }
      degradedReason = `${DEGRADED_NOTICE} (${detail})`;
      console.warn("[agent] Bedrock unavailable, degrading:", detail);
      await recordAuditEvent({
        sessionId: session.id,
        requestId: state.requestId,
        action: "error",
        resultSummary: `Bedrock reasoning unavailable: ${detail}`,
        isError: true,
      });
    }
  } else {
    degradedReason =
      "Amazon Bedrock is not configured (no AWS credentials resolved), so this decision was produced by " +
      "the deterministic policy engine. Structured facts, semantic memory retrieval, and policy evaluation " +
      "all ran normally.";
  }

  // Whether Bedrock ran or not, the deterministic path fills any gaps: it
  // guarantees a request exists and that policy has actually been evaluated.
  await ensureDeterministicFloor(state, input.message);

  const evaluation = state.policyEvaluation;
  if (!evaluation) throw new Error("Policy evaluation did not run");

  const reconciliation = reconcile(state.proposal?.decision ?? null, evaluation);
  const decision = reconciliation.decision;

  const rationale =
    state.proposal && !reconciliation.overrodeModel
      ? state.proposal.rationale
      : synthesizeRationale(decision, evaluation, state, reconciliation.reason);

  const nextAction =
    state.proposal && !reconciliation.overrodeModel && state.proposal.nextAction
      ? state.proposal.nextAction
      : evaluation.nextAction || defaultNextAction(decision);

  const evidence = dedupeEvidence([
    ...state.structuredEvidence,
    ...evaluation.evidence,
    ...(state.proposal?.evidence ?? []),
  ]);

  const requestId = state.requestId;
  if (!requestId) throw new Error("Agent finished without an associated request");

  const stored = await recordDecision({
    requestId,
    sessionId: session.id,
    decision,
    rationale,
    nextAction,
    evidence,
    policiesTriggered: evaluation.triggered,
    memoriesUsed: toMemoryReferences(state.retrievedMemories),
    toolsInvoked: state.invocations,
    actionsTaken: state.actions,
    structuredFactsCount: state.structuredFactsCount,
    semanticMemoriesCount: state.retrievedMemories.length,
    confidence: state.proposal?.confidence ?? (evaluation.mandatory ? "high" : "medium"),
    reasoningProvider: provider,
    model: provider === "bedrock" ? env().BEDROCK_MODEL_ID : null,
    policyOverrodeModel: reconciliation.overrodeModel,
    modelProposedDecision: state.proposal?.decision ?? null,
  });

  await applyDecisionEffects({
    decision,
    requestId,
    decisionId: stored.id,
    sessionId: session.id,
    rationale,
    nextAction,
    state,
  });

  await writeDecisionMemory({
    decision,
    rationale,
    requestId,
    decisionId: stored.id,
    state,
  });

  await completeSession({
    sessionId: session.id,
    status: "completed",
    requestId,
    latencyMs: Date.now() - started,
    inputTokens: usage.input,
    outputTokens: usage.output,
    reasoningProvider: provider,
    model: provider === "bedrock" ? env().BEDROCK_MODEL_ID : null,
  });

  await recordAuditEvent({
    sessionId: session.id,
    requestId,
    action: "decision.recorded",
    parameters: {
      decision,
      policy_overrode_model: reconciliation.overrodeModel,
      model_proposed: state.proposal?.decision ?? null,
    },
    resultSummary: `${decision} — ${rationale.slice(0, 160)}`,
    durationMs: Date.now() - started,
  });

  const request = await getRequestById(requestId);

  return {
    sessionId: session.id,
    requestId,
    requestReference: request?.reference ?? null,
    decisionId: stored.id,
    decision,
    rationale,
    nextAction,
    evidence,
    policiesTriggered: evaluation.triggered,
    memoriesUsed: state.retrievedMemories,
    toolsInvoked: state.invocations,
    actionsTaken: state.actions,
    confidence: state.proposal?.confidence ?? (evaluation.mandatory ? "high" : "medium"),
    reasoningProvider: provider,
    model: provider === "bedrock" ? env().BEDROCK_MODEL_ID : null,
    policyOverrodeModel: reconciliation.overrodeModel,
    policyOverrideReason: reconciliation.reason,
    modelProposedDecision: state.proposal?.decision ?? null,
    pipeline: buildPipeline(state, evaluation, decision),
    latencyMs: Date.now() - started,
    degradedReason,
  };
}

// --- Bedrock ---------------------------------------------------------------

function isBedrockConfigured(): boolean {
  return Boolean(
    process.env["AWS_ACCESS_KEY_ID"] ||
      process.env["AWS_PROFILE"] ||
      process.env["AWS_BEARER_TOKEN_BEDROCK"] ||
      process.env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"] ||
      process.env["AWS_WEB_IDENTITY_TOKEN_FILE"] ||
      process.env["AWS_ROLE_ARN"],
  );
}

let bedrockClient: AnthropicBedrockMantle | null = null;

function client(): AnthropicBedrockMantle {
  bedrockClient ??= new AnthropicBedrockMantle({ awsRegion: env().AWS_REGION });
  return bedrockClient;
}

function toolDefinitions(): Anthropic.Tool[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as unknown as Anthropic.Tool.InputSchema,
  }));
}

async function runBedrockLoop(
  state: AgentRunState,
  message: string,
): Promise<{ input: number; output: number }> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: message },
  ];

  let inputTokens = 0;
  let outputTokens = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await client().messages.create({
      model: env().BEDROCK_MODEL_ID,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(state.requester, new Date()),
      // Adaptive thinking with the default `display: "omitted"`: the model
      // reasons, but the raw chain of thought is never returned or stored.
      thinking: { type: "adaptive" },
      output_config: { effort: env().BEDROCK_EFFORT },
      tools: toolDefinitions(),
      messages,
    });

    inputTokens += response.usage.input_tokens ?? 0;
    outputTokens += response.usage.output_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      throw new Error(
        "The model declined to process this request. Review the request content.",
      );
    }

    // Echo the full assistant turn back, thinking blocks included — required
    // for multi-turn tool use with adaptive thinking.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      results.push(await executeTool(state, toolUse));
    }
    messages.push({ role: "user", content: results });

    // `record_decision` is terminal — stop as soon as the model commits.
    if (state.proposal) break;
  }

  return { input: inputTokens, output: outputTokens };
}

/**
 * The single path every tool call goes through, whether the model asked for it
 * or the deterministic floor did.
 *
 * Keeping one implementation is what makes the audit log trustworthy: a reader
 * should never have to know which code path invoked a tool to be sure it was
 * recorded. `source` distinguishes them without duplicating the machinery.
 */
async function runTool(
  state: AgentRunState,
  name: string,
  parameters: Record<string, unknown>,
  source: "model" | "deterministic-floor",
): Promise<ToolResult> {
  const started = Date.now();
  const definition = findTool(name);

  let result: ToolResult;
  if (!definition) {
    result = {
      summary: `Unknown tool: ${name}`,
      data: { error: `Unknown tool: ${name}` },
      isError: true,
    };
  } else {
    try {
      result = await definition.handler(parameters, state);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      result = {
        summary: `${name} failed: ${detail}`,
        data: { error: detail },
        isError: true,
      };
    }
  }

  const durationMs = Date.now() - started;

  state.invocations.push({
    tool: name,
    parameters: { ...parameters, invoked_by: source },
    result_summary: result.summary,
    duration_ms: durationMs,
    is_error: result.isError ?? false,
  });

  await recordAuditEvent({
    sessionId: state.sessionId,
    requestId: state.requestId,
    action: "tool.invoked",
    toolName: name,
    parameters: { ...parameters, invoked_by: source },
    resultSummary: result.summary,
    durationMs,
    isError: result.isError ?? false,
  });

  return result;
}

async function executeTool(
  state: AgentRunState,
  toolUse: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  const result = await runTool(
    state,
    toolUse.name,
    (toolUse.input ?? {}) as Record<string, unknown>,
    "model",
  );

  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: JSON.stringify(result.data),
    is_error: result.isError ?? false,
  };
}

// --- Deterministic floor ----------------------------------------------------

/**
 * Guarantees the invariants the rest of the pipeline depends on, whether or not
 * a model ran: a request row exists, semantic memory was searched, and policy
 * was evaluated. On the Bedrock path these are usually already satisfied and
 * this is a no-op.
 */
async function ensureDeterministicFloor(
  state: AgentRunState,
  message: string,
): Promise<void> {
  if (!state.requestId) {
    const parsed = parseRequest(message);
    const created = await createRequest({
      requesterId: state.requester.id,
      teamId: state.requester.team_id,
      title: parsed.title,
      body: message,
      requestType: parsed.requestType,
      resourceKind: parsed.resourceKind,
      quantity: parsed.quantity,
      estimatedMonthlyCostUsd: parsed.estimatedMonthlyCostUsd,
      vendor: parsed.vendor,
      environment: parsed.environment,
      durationDays: parsed.durationDays,
    });
    state.requestId = created.id;
    state.requestFacts = toRequestFacts(created);

    state.invocations.push({
      tool: "create_request",
      parameters: { invoked_by: "deterministic-parser" },
      result_summary: `Created ${created.reference}: ${created.title}`,
      duration_ms: 0,
      is_error: false,
    });

    await recordAuditEvent({
      sessionId: state.sessionId,
      requestId: created.id,
      action: "tool.invoked",
      toolName: "create_request",
      parameters: { invoked_by: "deterministic-parser", parsed },
      resultSummary: `Created ${created.reference}: ${created.title}`,
    });
  }

  if (!state.requestFacts) {
    const request = await getRequestById(state.requestId);
    if (request) state.requestFacts = toRequestFacts(request);
  }
  if (!state.requestFacts) throw new Error("Request facts unavailable");

  // Availability is checked for anything involving a resource. Deciding to
  // provision without first looking at what the team already owns is the exact
  // mistake this system exists to prevent, so it does not depend on the model
  // choosing to call the tool.
  if (
    state.requestFacts.resourceKind &&
    !state.invocations.some((i) => i.tool === "check_availability")
  ) {
    await runTool(
      state,
      "check_availability",
      { resource_kind: state.requestFacts.resourceKind },
      "deterministic-floor",
    );
  }

  // Semantic recall always runs. A decision made without consulting memory is
  // exactly the failure mode this product exists to fix.
  if (state.retrievedMemories.length === 0) {
    await runTool(
      state,
      "search_memory",
      { query: `${state.requestFacts.title}. ${state.requestFacts.body}` },
      "deterministic-floor",
    );
  }

  if (!state.policyEvaluation) {
    const [context, policies] = await Promise.all([
      buildPolicyContext({
        request: state.requestFacts,
        requester: state.requester,
      }),
      listPolicies({ enabledOnly: true }),
    ]);
    const evaluation = evaluatePolicies(context, policies);
    state.policyEvaluation = evaluation;

    // Structured facts the rules already surfaced — the "N structured facts"
    // number on the Agent page has to mean something.
    state.structuredFactsCount += evaluation.evidence.filter(
      (e) => e.source === "structured",
    ).length;

    state.invocations.push({
      tool: "evaluate_policy",
      parameters: { invoked_by: "deterministic-floor" },
      result_summary: evaluation.verdict
        ? `Verdict ${evaluation.verdict}${evaluation.mandatory ? " (binding)" : " (advisory)"}`
        : "No policy mandated a decision",
      duration_ms: 0,
      is_error: false,
    });

    await recordAuditEvent({
      sessionId: state.sessionId,
      requestId: state.requestId,
      action: "tool.invoked",
      toolName: "evaluate_policy",
      parameters: { invoked_by: "deterministic-floor" },
      resultSummary: evaluation.verdict
        ? `Verdict ${evaluation.verdict}${evaluation.mandatory ? " (binding)" : " (advisory)"}`
        : "No policy mandated a decision",
    });

    await recordAuditEvent({
      sessionId: state.sessionId,
      requestId: state.requestId,
      action: "policy.evaluated",
      parameters: { triggered: evaluation.triggered.map((t) => t.key) },
      resultSummary: evaluation.verdict
        ? `Deterministic verdict: ${evaluation.verdict}`
        : "No policy mandated a decision",
    });
  }

  await fulfilReuseIfRequested(state, message);
}

/** Same heuristic the console uses to decide whether a message continues an open request. */
const REUSE_CONFIRMATION =
  /\b(ok(ay)?|yes|sure|go ahead|do that|use (the )?(existing|that|it)|reuse|instead|that works|sounds good|proceed)\b/i;

/**
 * "Okay, use the existing one."
 *
 * When the requester agrees to reuse, the allocation is a mechanical
 * consequence, not a judgement call — so it happens on the deterministic path
 * too. This fires either when the request was explicitly typed as a reuse, or
 * when a follow-up message on an open request reads as agreement to the
 * reuse the agent already offered. With Bedrock available the model normally
 * calls `reserve_existing_resource` itself and this is a no-op.
 */
async function fulfilReuseIfRequested(
  state: AgentRunState,
  message: string,
): Promise<void> {
  const facts = state.requestFacts;
  if (!facts || !facts.resourceKind) return;
  if (state.actions.some((a) => a.action === "resource.reused")) return;

  const explicitReuseType = facts.requestType === "resource_reuse";
  const confirmedFollowUp =
    REUSE_CONFIRMATION.test(message) &&
    state.policyEvaluation?.triggered.some(
      (t) => t.key === "reuse-before-provision",
    );
  if (!explicitReuseType && !confirmedFollowUp) return;

  const evaluation = state.policyEvaluation;
  if (evaluation?.verdict === "REJECT" && evaluation.mandatory) return;

  const candidates = await findReusableResources(
    state.requester.team_id,
    facts.resourceKind,
  );
  const target = candidates[0];
  if (!target) return;

  const result = await runTool(
    state,
    "reserve_existing_resource",
    {
      resource_id: target.id,
      purpose: facts.title,
      duration_days: facts.durationDays,
    },
    "deterministic-floor",
  );
  if (result.isError) return;

  // The reuse this policy was asking about has now happened — the request is
  // resolved, not still pending information. Fold that outcome back into the
  // evaluation so reconcile() lands on APPROVE rather than repeating the
  // original REQUEST_INFORMATION verdict.
  state.policyEvaluation = {
    ...(evaluation ?? {
      triggered: [],
      evidence: [],
      verdict: null,
      mandatory: false,
      nextAction: "",
      evaluatedKeys: [],
    }),
    verdict: "APPROVE",
    mandatory: true,
    nextAction: `Confirm ${target.name} is allocated and no new capacity is needed.`,
  };
}

// --- Decision effects -------------------------------------------------------

const STATUS_FOR_DECISION: Readonly<Record<Decision, RequestStatus>> = {
  APPROVE: "approved",
  REJECT: "rejected",
  REQUEST_APPROVAL: "pending",
  REQUEST_INFORMATION: "needs_information",
  FLAG_FOR_REVIEW: "under_review",
};

/**
 * Approving, rejecting, and escalating happen here — after reconciliation —
 * rather than as model-callable tools. A model that can flip a request to
 * `approved` directly can route around the policy engine, and holding that line
 * is the difference between an assistant and something you would let run
 * unattended.
 */
async function applyDecisionEffects(input: {
  decision: Decision;
  requestId: string;
  decisionId: string;
  sessionId: string;
  rationale: string;
  nextAction: string;
  state: AgentRunState;
}): Promise<void> {
  const { decision, requestId, decisionId, sessionId, state } = input;

  await updateRequestStatus(requestId, STATUS_FOR_DECISION[decision]);

  await addRequestEvent({
    requestId,
    eventType: "agent_decision",
    actorType: "agent",
    summary: `${decision}: ${input.rationale}`,
    payload: { decision_id: decisionId, next_action: input.nextAction },
  });

  if (decision === "REQUEST_APPROVAL" || decision === "FLAG_FOR_REVIEW") {
    const approval = await createApproval({
      requestId,
      decisionId,
      requiredRole: decision === "FLAG_FOR_REVIEW" ? "admin" : "lead",
      reason: input.nextAction || input.rationale,
    });

    state.actions.push({
      action: decision === "FLAG_FOR_REVIEW" ? "review.requested" : "approval.requested",
      detail: input.nextAction || input.rationale,
      entity_id: approval.id,
    });

    await recordAuditEvent({
      sessionId,
      requestId,
      action: "approval.requested",
      parameters: { approval_id: approval.id, required_role: approval.required_role },
      resultSummary: `Escalated to ${approval.required_role} for human decision`,
    });
  }
}

/**
 * Memory creation is not optional and not left to the model's discretion: every
 * decision becomes a durable memory, because the next request needs it.
 */
async function writeDecisionMemory(input: {
  decision: Decision;
  rationale: string;
  requestId: string;
  decisionId: string;
  state: AgentRunState;
}): Promise<void> {
  const { state } = input;
  const facts = state.requestFacts;
  if (!facts) return;

  // Written to read like a colleague's note, because it will be retrieved months
  // later with none of this context around it.
  const subject = facts.resourceKind
    ? kindLabel(facts.resourceKind, facts.quantity)
    : facts.requestType.replace(/_/g, " ");

  const quantity =
    facts.quantity > 1 ? `${facts.quantity} ` : facts.resourceKind ? "a " : "";

  const qualifiers = [
    facts.vendor ? `from ${facts.vendor}` : null,
    facts.environment ? `for ${facts.environment}` : null,
    facts.durationDays ? `for ${facts.durationDays} days` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const content = [
    `${state.requester.name} (${state.requester.team_name}) asked for ${quantity}${subject}`,
    qualifiers ? ` ${qualifiers}` : "",
    facts.reference ? ` in ${facts.reference}` : "",
    `. Memento decided ${input.decision.replace(/_/g, " ").toLowerCase()}: `,
    input.rationale,
  ].join("");

  await remember({
    content: content.replace(/\s+/g, " ").trim(),
    summary:
      `${input.decision.replace(/_/g, " ").toLowerCase()} — ${facts.title}`.slice(
        0,
        120,
      ),
    memoryType: "decision",
    importance: input.decision === "APPROVE" ? 3 : 4,
    sourceKind: "decision",
    sourceRequestId: input.requestId,
    sourceDecisionId: input.decisionId,
    subjectTeamId: state.requester.team_id,
    subjectUserId: state.requester.id,
    sessionId: state.sessionId,
    metadata: {
      decision: input.decision,
      request_reference: facts.reference,
      resource_kind: facts.resourceKind,
    },
  });
}

// --- Presentation helpers ---------------------------------------------------

function toRequestFacts(request: {
  id: string;
  reference: string;
  title: string;
  body: string;
  request_type: RequestFacts["requestType"];
  resource_kind: RequestFacts["resourceKind"];
  quantity: number;
  estimated_monthly_cost_usd: number | null;
  vendor: string | null;
  environment: string | null;
  duration_days: number | null;
}): RequestFacts {
  return {
    id: request.id,
    reference: request.reference,
    title: request.title,
    body: request.body,
    requestType: request.request_type,
    resourceKind: request.resource_kind,
    quantity: request.quantity,
    estimatedMonthlyCostUsd: request.estimated_monthly_cost_usd,
    vendor: request.vendor,
    environment: request.environment,
    durationDays: request.duration_days,
  };
}

function dedupeEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of items) {
    const key = item.label.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function defaultNextAction(decision: Decision): string {
  switch (decision) {
    case "APPROVE":
      return "Provision the request and notify the requester.";
    case "REJECT":
      return "Notify the requester and point them at the applicable policy.";
    case "REQUEST_APPROVAL":
      return "Await a decision from the team lead.";
    case "REQUEST_INFORMATION":
      return "Ask the requester for the missing detail.";
    case "FLAG_FOR_REVIEW":
      return "Route to the Security team for review.";
  }
}

/** Used when no model ran, or when policy overrode what the model proposed. */
function synthesizeRationale(
  decision: Decision,
  evaluation: NonNullable<AgentRunState["policyEvaluation"]>,
  state: AgentRunState,
  overrideReason: string | null,
): string {
  const reused = state.actions.find((a) => a.action === "resource.reused");
  if (reused) {
    // The reuse fulfilment path rewrites the verdict to APPROVE after the
    // allocation happens, so no `triggered` entry actually explains an
    // APPROVE — the action itself is the explanation.
    return `${reused.detail} No new capacity was provisioned.`;
  }

  const parts: string[] = [];

  const deciding = evaluation.triggered.find((t) => t.verdict === decision);
  parts.push(
    deciding?.explanation ??
      `No organizational policy blocks this request, and nothing in ${state.requester.team_name}'s ` +
        `current capacity or history contradicts it.`,
  );

  // Prefer the advisory that most changes the picture — capacity about to
  // return — over a generic "we have seen this before".
  const advisory = evaluation.triggered.filter(
    (t) => t.verdict === null && t.explanation,
  );
  const expiring = advisory.find((t) => t.key === "expiring-allocation-awareness");
  const chosen = expiring ?? advisory[0];
  if (chosen) parts.push(chosen.explanation);

  const topMemory = state.retrievedMemories[0];
  if (topMemory) parts.push(firstSentence(topMemory.content));

  if (overrideReason) parts.push(overrideReason);

  return parts.join(" ");
}

/** Keeps a synthesised rationale readable rather than quoting a whole memory. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^.*?[.!?](\s|$)/.exec(trimmed);
  const sentence = (match?.[0] ?? trimmed).trim();
  return sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence;
}

/**
 * The retrieval pipeline rendered on the Agent page — a literal account of what
 * the agent looked at, in the order it looked.
 */
function buildPipeline(
  state: AgentRunState,
  evaluation: NonNullable<AgentRunState["policyEvaluation"]>,
  decision: Decision,
): PipelineStage[] {
  const structuredCount = state.structuredFactsCount;
  const memoryCount = state.retrievedMemories.length;
  const policyCount = evaluation.triggered.length;
  const availabilityChecked = state.invocations.some(
    (i) => i.tool === "check_availability",
  );

  return [
    {
      key: "request",
      label: "Request received",
      detail: state.requestFacts?.title ?? "Operational request",
      count: null,
      status: "ok",
    },
    {
      key: "structured",
      label: "Structured memory queried",
      detail:
        structuredCount === 0
          ? "No structured facts were material to this decision"
          : `${structuredCount} organizational fact${structuredCount === 1 ? "" : "s"} from CockroachDB tables`,
      count: structuredCount,
      status: structuredCount > 0 ? "ok" : "empty",
    },
    {
      key: "semantic",
      label: "Semantic memory retrieved",
      detail:
        memoryCount === 0
          ? "No past memory passed the similarity threshold"
          : `${memoryCount} memor${memoryCount === 1 ? "y" : "ies"} via CockroachDB vector search`,
      count: memoryCount,
      status: memoryCount > 0 ? "ok" : "empty",
    },
    {
      key: "availability",
      label: "Resource availability checked",
      detail: availabilityChecked
        ? "Existing capacity evaluated before considering new capacity"
        : "Not applicable to this request",
      count: null,
      status: availabilityChecked ? "ok" : "empty",
    },
    {
      key: "policy",
      label: "Policies evaluated",
      detail:
        policyCount === 0
          ? "No policy was triggered"
          : `${policyCount} polic${policyCount === 1 ? "y" : "ies"} triggered${evaluation.verdict ? `, verdict ${evaluation.verdict}` : ""}`,
      count: policyCount,
      status: policyCount > 0 ? "ok" : "empty",
    },
    {
      key: "decision",
      label: "Decision",
      detail: decision,
      count: null,
      status: "ok",
    },
  ];
}

async function failSession(
  sessionId: string,
  started: number,
  error: string,
): Promise<void> {
  await completeSession({
    sessionId,
    status: "failed",
    latencyMs: Date.now() - started,
    error,
  });
}

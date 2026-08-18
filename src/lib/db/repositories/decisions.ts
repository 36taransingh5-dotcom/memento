import { query, queryOne } from "@/lib/db/client";
import type {
  ActionTaken,
  AgentDecision,
  AgentSession,
  Approval,
  ApprovalWithContext,
  Decision,
  DecisionWithRequest,
  EvidenceItem,
  MemoryReference,
  ReasoningProvider,
  ToolInvocation,
  TriggeredPolicy,
} from "@/lib/db/types";

// --- Sessions --------------------------------------------------------------

export async function startSession(input: {
  userId: string;
  requestId?: string | null;
  channel?: string;
  model?: string | null;
  reasoningProvider: ReasoningProvider;
}): Promise<AgentSession> {
  const rows = await query<AgentSession>(
    `INSERT INTO agent_sessions (user_id, request_id, channel, model, reasoning_provider)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      input.userId,
      input.requestId ?? null,
      input.channel ?? "web",
      input.model ?? null,
      input.reasoningProvider,
    ],
  );
  const session = rows[0];
  if (!session) throw new Error("Failed to start agent session");
  return session;
}

export async function completeSession(input: {
  sessionId: string;
  status: "completed" | "failed";
  requestId?: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningProvider?: ReasoningProvider;
  model?: string | null;
  error?: string | null;
}): Promise<void> {
  await query(
    `UPDATE agent_sessions
        SET status = $2,
            request_id = coalesce($3, request_id),
            latency_ms = $4,
            input_tokens = $5,
            output_tokens = $6,
            reasoning_provider = coalesce($7, reasoning_provider),
            model = coalesce($8, model),
            error = $9,
            ended_at = now()
      WHERE id = $1`,
    [
      input.sessionId,
      input.status,
      input.requestId ?? null,
      input.latencyMs,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.reasoningProvider ?? null,
      input.model ?? null,
      input.error ?? null,
    ],
  );
}

export async function listRecentSessions(limit = 20): Promise<
  Array<AgentSession & { user_name: string; request_reference: string | null }>
> {
  return query(
    `SELECT s.*, u.name AS user_name, r.reference AS request_reference
       FROM agent_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN requests r ON r.id = s.request_id
      ORDER BY s.started_at DESC
      LIMIT $1`,
    [limit],
  );
}

// --- Decisions -------------------------------------------------------------

export interface RecordDecisionInput {
  requestId: string;
  sessionId: string | null;
  decision: Decision;
  rationale: string;
  nextAction: string;
  evidence: EvidenceItem[];
  policiesTriggered: TriggeredPolicy[];
  memoriesUsed: MemoryReference[];
  toolsInvoked: ToolInvocation[];
  actionsTaken: ActionTaken[];
  structuredFactsCount: number;
  semanticMemoriesCount: number;
  confidence: "high" | "medium" | "low";
  reasoningProvider: ReasoningProvider;
  model: string | null;
  policyOverrodeModel: boolean;
  modelProposedDecision: Decision | null;
}

export async function recordDecision(
  input: RecordDecisionInput,
): Promise<AgentDecision> {
  const rows = await query<AgentDecision>(
    `INSERT INTO agent_decisions
       (request_id, session_id, decision, rationale, next_action, evidence,
        policies_triggered, memories_used, tools_invoked, actions_taken,
        structured_facts_count, semantic_memories_count, confidence,
        reasoning_provider, model, policy_overrode_model, model_proposed_decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      input.requestId,
      input.sessionId,
      input.decision,
      input.rationale,
      input.nextAction,
      JSON.stringify(input.evidence),
      JSON.stringify(input.policiesTriggered),
      JSON.stringify(input.memoriesUsed),
      JSON.stringify(input.toolsInvoked),
      JSON.stringify(input.actionsTaken),
      input.structuredFactsCount,
      input.semanticMemoriesCount,
      input.confidence,
      input.reasoningProvider,
      input.model,
      input.policyOverrodeModel,
      input.modelProposedDecision,
    ],
  );
  const decision = rows[0];
  if (!decision) throw new Error("Failed to record decision");
  return decision;
}

const DECISION_WITH_REQUEST = `
  SELECT d.*,
         r.reference AS request_reference,
         r.title     AS request_title,
         u.name      AS requester_name,
         t.name      AS team_name
    FROM agent_decisions d
    JOIN requests r ON r.id = d.request_id
    JOIN users u ON u.id = r.requester_id
    JOIN teams t ON t.id = r.team_id
`;

export async function listRecentDecisions(
  limit = 20,
): Promise<DecisionWithRequest[]> {
  return query<DecisionWithRequest>(
    `${DECISION_WITH_REQUEST} ORDER BY d.created_at DESC LIMIT $1`,
    [limit],
  );
}

export async function getDecisionById(
  id: string,
): Promise<DecisionWithRequest | null> {
  return queryOne<DecisionWithRequest>(
    `${DECISION_WITH_REQUEST} WHERE d.id = $1`,
    [id],
  );
}

export async function listDecisionsForRequest(
  requestId: string,
): Promise<AgentDecision[]> {
  return query<AgentDecision>(
    `SELECT * FROM agent_decisions WHERE request_id = $1 ORDER BY created_at DESC`,
    [requestId],
  );
}

/**
 * How often each decision was reached. Drives the Overview page and is a proxy
 * for "is the agent actually deciding, or just escalating everything?".
 */
export async function countDecisionsByType(): Promise<
  Array<{ decision: Decision; count: number }>
> {
  return query(
    `SELECT decision, count(*)::INT AS count
       FROM agent_decisions
      GROUP BY decision
      ORDER BY count DESC`,
  );
}

// --- Approvals -------------------------------------------------------------

export async function createApproval(input: {
  requestId: string;
  decisionId: string | null;
  requiredRole: "lead" | "admin";
  reason: string;
}): Promise<Approval> {
  const rows = await query<Approval>(
    `INSERT INTO approvals (request_id, decision_id, required_role, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.requestId, input.decisionId, input.requiredRole, input.reason],
  );
  const approval = rows[0];
  if (!approval) throw new Error("Failed to create approval");
  return approval;
}

export async function listPendingApprovals(): Promise<ApprovalWithContext[]> {
  return query<ApprovalWithContext>(
    `SELECT a.*,
            r.reference AS request_reference,
            r.title     AS request_title,
            u.name      AS requester_name,
            t.name      AS team_name
       FROM approvals a
       JOIN requests r ON r.id = a.request_id
       JOIN users u ON u.id = r.requester_id
       JOIN teams t ON t.id = r.team_id
      WHERE a.status = 'pending'
      ORDER BY a.created_at ASC`,
  );
}

export async function resolveApproval(input: {
  approvalId: string;
  approverId: string;
  status: "approved" | "rejected";
  note?: string;
}): Promise<Approval | null> {
  return queryOne<Approval>(
    `UPDATE approvals
        SET status = $2, approver_id = $3, resolution_note = $4, resolved_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [input.approvalId, input.status, input.approverId, input.note ?? null],
  );
}

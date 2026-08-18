import type {
  ActionTaken,
  Decision,
  EvidenceItem,
  ReasoningProvider,
  RetrievedMemory,
  ToolInvocation,
  UserWithTeam,
} from "@/lib/db/types";
import type { PolicyEvaluation, RequestFacts } from "@/lib/policy/types";

/** What the model proposes via the terminal `record_decision` tool. */
export interface DecisionProposal {
  decision: Decision;
  rationale: string;
  nextAction: string;
  evidence: EvidenceItem[];
  confidence: "high" | "medium" | "low";
}

/**
 * Mutable state threaded through a single agent run.
 *
 * Tools append to the accumulators rather than returning them, so the decision
 * trace is complete even when the model stops early or errors out.
 */
export interface AgentRunState {
  sessionId: string;
  requester: UserWithTeam;
  /** Set once the agent calls `create_request`, or supplied up front. */
  requestId: string | null;
  requestFacts: RequestFacts | null;
  invocations: ToolInvocation[];
  retrievedMemories: RetrievedMemory[];
  structuredEvidence: EvidenceItem[];
  actions: ActionTaken[];
  policyEvaluation: PolicyEvaluation | null;
  proposal: DecisionProposal | null;
  structuredFactsCount: number;
}

export interface ToolResult {
  /** One-line summary written to the audit log. */
  summary: string;
  /** JSON returned to the model as the tool result. */
  data: unknown;
  isError?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  handler: (
    input: Record<string, unknown>,
    state: AgentRunState,
  ) => Promise<ToolResult>;
}

/** One node in the retrieval pipeline shown on the Agent page. */
export interface PipelineStage {
  key: string;
  label: string;
  detail: string;
  count: number | null;
  status: "ok" | "empty" | "error";
}

export interface AgentRunResult {
  sessionId: string;
  requestId: string | null;
  requestReference: string | null;
  decisionId: string | null;
  decision: Decision;
  rationale: string;
  nextAction: string;
  evidence: EvidenceItem[];
  policiesTriggered: PolicyEvaluation["triggered"];
  memoriesUsed: RetrievedMemory[];
  toolsInvoked: ToolInvocation[];
  actionsTaken: ActionTaken[];
  confidence: "high" | "medium" | "low";
  reasoningProvider: ReasoningProvider;
  model: string | null;
  policyOverrodeModel: boolean;
  policyOverrideReason: string | null;
  modelProposedDecision: Decision | null;
  pipeline: PipelineStage[];
  latencyMs: number;
  degradedReason: string | null;
}

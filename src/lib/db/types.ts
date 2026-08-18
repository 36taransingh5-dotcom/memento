/**
 * Domain types mirroring db/migrations/001_init.sql.
 *
 * Kept hand-written rather than generated so the shape of Memento's memory is
 * legible in one file.
 */

export type Role = "member" | "lead" | "admin";

export type ResourceKind =
  | "gpu"
  | "cloud_instance"
  | "saas_license"
  | "production_service";

export type ResourceStatus =
  | "available"
  | "in_use"
  | "idle"
  | "maintenance"
  | "retired";

export type RequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "needs_information"
  | "under_review"
  | "withdrawn"
  | "fulfilled";

export type RequestType =
  | "resource_provision"
  | "resource_reuse"
  | "saas_license"
  | "service_addition"
  | "access"
  | "other";

/** The five decisions the agent may return. Nothing else is representable. */
export type Decision =
  | "APPROVE"
  | "REJECT"
  | "REQUEST_APPROVAL"
  | "REQUEST_INFORMATION"
  | "FLAG_FOR_REVIEW";

export const DECISIONS: readonly Decision[] = [
  "APPROVE",
  "REJECT",
  "REQUEST_APPROVAL",
  "REQUEST_INFORMATION",
  "FLAG_FOR_REVIEW",
] as const;

export type MemoryType =
  | "decision"
  | "outcome"
  | "policy_exception"
  | "preference"
  | "event"
  | "expiration"
  | "constraint";

export type PolicySeverity = "hard" | "soft";
export type PolicyCategory =
  | "resource"
  | "budget"
  | "vendor"
  | "security"
  | "process";
export type PolicyEffect =
  | "reject"
  | "require_approval"
  | "request_information"
  | "flag_for_review"
  | "advisory";

export type ReasoningProvider = "bedrock" | "deterministic";

export interface Team {
  id: string;
  key: string;
  name: string;
  description: string;
  monthly_budget_usd: number;
  monthly_spend_usd: number;
  gpu_cap: number;
  created_at: Date;
}

export interface User {
  id: string;
  email: string;
  name: string;
  title: string;
  team_id: string;
  role: Role;
  created_at: Date;
}

export interface UserWithTeam extends User {
  team_name: string;
  team_key: string;
}

export interface Resource {
  id: string;
  key: string;
  name: string;
  kind: ResourceKind;
  specification: Record<string, unknown>;
  vendor: string | null;
  monthly_cost_usd: number;
  owner_team_id: string | null;
  status: ResourceStatus;
  utilization_percent: number;
  region: string;
  created_at: Date;
  updated_at: Date;
}

export interface ResourceWithContext extends Resource {
  owner_team_name: string | null;
  active_allocation_id: string | null;
  allocation_type: "permanent" | "temporary" | null;
  allocation_expires_at: Date | null;
  allocation_holder: string | null;
  allocation_purpose: string | null;
}

export interface ResourceAllocation {
  id: string;
  resource_id: string;
  team_id: string;
  user_id: string | null;
  request_id: string | null;
  allocation_type: "permanent" | "temporary";
  purpose: string;
  starts_at: Date;
  expires_at: Date | null;
  released_at: Date | null;
  created_at: Date;
}

export interface OperationalRequest {
  id: string;
  reference: string;
  requester_id: string;
  team_id: string;
  title: string;
  body: string;
  request_type: RequestType;
  resource_kind: ResourceKind | null;
  quantity: number;
  estimated_monthly_cost_usd: number | null;
  vendor: string | null;
  environment: string | null;
  duration_days: number | null;
  status: RequestStatus;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

export interface RequestWithContext extends OperationalRequest {
  requester_name: string;
  requester_email: string;
  team_name: string;
  latest_decision: Decision | null;
  latest_decision_at: Date | null;
}

export interface RequestEvent {
  id: string;
  request_id: string;
  event_type: string;
  actor_type: "user" | "agent" | "system";
  actor_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface Policy {
  id: string;
  key: string;
  name: string;
  description: string;
  category: PolicyCategory;
  severity: PolicySeverity;
  effect: PolicyEffect;
  rule: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AgentSession {
  id: string;
  user_id: string;
  request_id: string | null;
  channel: string;
  status: "active" | "completed" | "failed";
  model: string | null;
  reasoning_provider: ReasoningProvider;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
}

/** One item of the auditable decision trace. Never chain-of-thought. */
export interface EvidenceItem {
  label: string;
  detail: string;
  source: "structured" | "semantic" | "policy" | "computed";
}

export interface TriggeredPolicy {
  key: string;
  name: string;
  severity: PolicySeverity;
  effect: PolicyEffect;
  verdict: Decision | null;
  explanation: string;
}

export interface MemoryReference {
  id: string;
  summary: string;
  content: string;
  similarity: number;
  memory_type: MemoryType;
  occurred_at: string;
}

export interface ToolInvocation {
  tool: string;
  parameters: Record<string, unknown>;
  result_summary: string;
  duration_ms: number;
  is_error: boolean;
}

export interface ActionTaken {
  action: string;
  detail: string;
  entity_id: string | null;
}

export interface AgentDecision {
  id: string;
  request_id: string;
  session_id: string | null;
  decision: Decision;
  rationale: string;
  next_action: string;
  evidence: EvidenceItem[];
  policies_triggered: TriggeredPolicy[];
  memories_used: MemoryReference[];
  tools_invoked: ToolInvocation[];
  actions_taken: ActionTaken[];
  structured_facts_count: number;
  semantic_memories_count: number;
  confidence: "high" | "medium" | "low";
  reasoning_provider: ReasoningProvider;
  model: string | null;
  policy_overrode_model: boolean;
  model_proposed_decision: Decision | null;
  created_at: Date;
}

export interface DecisionWithRequest extends AgentDecision {
  request_reference: string;
  request_title: string;
  requester_name: string;
  team_name: string;
}

export interface Approval {
  id: string;
  request_id: string;
  decision_id: string | null;
  required_role: "lead" | "admin";
  reason: string;
  approver_id: string | null;
  status: "pending" | "approved" | "rejected";
  resolution_note: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export interface ApprovalWithContext extends Approval {
  request_reference: string;
  request_title: string;
  requester_name: string;
  team_name: string;
}

export interface AgentMemory {
  id: string;
  content: string;
  summary: string;
  memory_type: MemoryType;
  importance: number;
  embedding_model: string | null;
  source_kind: "request" | "decision" | "allocation" | "manual" | "system";
  source_request_id: string | null;
  source_decision_id: string | null;
  subject_team_id: string | null;
  subject_user_id: string | null;
  subject_resource_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  expires_at: Date | null;
  superseded_by: string | null;
  created_at: Date;
}

export interface MemoryWithContext extends AgentMemory {
  team_name: string | null;
  user_name: string | null;
  resource_name: string | null;
  source_request_reference: string | null;
  source_request_title: string | null;
}

export interface RetrievedMemory extends MemoryWithContext {
  /** Cosine similarity in [0, 1]; 1 is identical. */
  similarity: number;
}

export interface AuditEvent {
  id: string;
  session_id: string | null;
  request_id: string | null;
  actor_type: "user" | "agent" | "system";
  actor_id: string | null;
  action: string;
  tool_name: string | null;
  parameters: Record<string, unknown>;
  result_summary: string;
  duration_ms: number;
  is_error: boolean;
  created_at: Date;
}

export interface AuditEventWithContext extends AuditEvent {
  request_reference: string | null;
  actor_name: string | null;
}

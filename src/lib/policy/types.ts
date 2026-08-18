import type {
  Decision,
  EvidenceItem,
  Policy,
  RequestType,
  ResourceKind,
  ResourceWithContext,
  Team,
  TriggeredPolicy,
  UserWithTeam,
} from "@/lib/db/types";
import type { TeamResourceUsage } from "@/lib/db/repositories/resources";

/** The structured shape of a request, as parsed before any policy runs. */
export interface RequestFacts {
  id: string | null;
  reference: string | null;
  title: string;
  body: string;
  requestType: RequestType;
  resourceKind: ResourceKind | null;
  quantity: number;
  estimatedMonthlyCostUsd: number | null;
  vendor: string | null;
  environment: string | null;
  durationDays: number | null;
}

export interface ExpiringAllocation {
  id: string;
  resource_id: string;
  resource_name: string;
  resource_key: string;
  resource_kind: ResourceKind;
  holder_name: string | null;
  expires_at: Date | null;
  purpose: string;
}

export interface PriorRequestSummary {
  id: string;
  reference: string;
  title: string;
  status: string;
  decision: Decision | null;
  created_at: Date;
  requester_name: string;
}

/**
 * Everything a rule is allowed to look at.
 *
 * Rules are pure functions of this context: no database access, no network, no
 * randomness. That is what makes the policy layer deterministic, unit-testable,
 * and trustworthy enough to override a language model.
 */
export interface PolicyContext {
  request: RequestFacts;
  requester: UserWithTeam;
  team: Team;
  teamUsage: TeamResourceUsage[];
  reusableResources: ResourceWithContext[];
  expiringAllocations: ExpiringAllocation[];
  priorRequests: PriorRequestSummary[];
  now: Date;
}

export interface RuleOutcome {
  /** The decision this rule mandates, or null for advisory-only findings. */
  verdict: Decision | null;
  explanation: string;
  evidence: EvidenceItem[];
  nextAction?: string;
}

export type RuleEvaluator = (
  context: PolicyContext,
  rule: Record<string, unknown>,
) => RuleOutcome | null;

export interface PolicyEvaluation {
  triggered: TriggeredPolicy[];
  evidence: EvidenceItem[];
  /** The decision the deterministic engine requires, if any. */
  verdict: Decision | null;
  /** True when `verdict` came from a `hard` policy and cannot be overridden. */
  mandatory: boolean;
  nextAction: string;
  /** Keys of policies that were evaluated but did not fire. */
  evaluatedKeys: string[];
}

export type { Policy };

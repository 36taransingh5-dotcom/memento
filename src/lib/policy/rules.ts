import type { EvidenceItem, ResourceKind } from "@/lib/db/types";
import type { PolicyContext, RuleEvaluator, RuleOutcome } from "@/lib/policy/types";

/**
 * The deterministic rule library.
 *
 * Each evaluator is a pure function of PolicyContext. The LLM never sees these
 * implementations and is never asked to reproduce them — it only ever receives
 * the verdicts they produced. That separation is the whole point: the model
 * interprets an ambiguous request; these functions decide what is allowed.
 *
 * Parameters come from `policies.rule` (JSONB) so an operator can retune a
 * threshold without a deploy.
 */

function num(rule: Record<string, unknown>, key: string, fallback: number): number {
  const value = rule[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strArray(rule: Record<string, unknown>, key: string): string[] {
  const value = rule[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function record(rule: Record<string, unknown>, key: string): Record<string, string> {
  const value = rule[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function usageFor(context: PolicyContext, kind: ResourceKind) {
  return context.teamUsage.find((u) => u.kind === kind);
}

const KIND_LABELS: Readonly<Record<ResourceKind, [string, string]>> = {
  gpu: ["GPU", "GPUs"],
  cloud_instance: ["cloud instance", "cloud instances"],
  saas_license: ["SaaS license", "SaaS licenses"],
  production_service: ["production service", "production services"],
};

/** Renders a resource kind for human-readable evidence and explanations. */
export function kindLabel(kind: ResourceKind, count: number): string {
  const [singular, plural] = KIND_LABELS[kind];
  return count === 1 ? singular : plural;
}

function formatDay(date: Date, now: Date): string {
  const days = Math.round(
    (date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

// ---------------------------------------------------------------------------

/**
 * Fields the agent needs before it can decide anything. Asking one clear
 * question beats guessing and being wrong.
 */
const missingInformation: RuleEvaluator = (context, rule) => {
  const requiredByType = rule["required_by_type"];
  const requirements =
    requiredByType && typeof requiredByType === "object"
      ? (requiredByType as Record<string, unknown>)
      : {};

  const required = Array.isArray(requirements[context.request.requestType])
    ? (requirements[context.request.requestType] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      )
    : [];

  const missing: string[] = [];
  for (const field of required) {
    const value = (context.request as unknown as Record<string, unknown>)[
      toCamel(field)
    ];
    if (value === null || value === undefined || value === "") missing.push(field);
  }

  if (missing.length === 0) return null;

  return {
    verdict: "REQUEST_INFORMATION",
    explanation: `Required detail is missing: ${missing.join(", ")}.`,
    nextAction: `Ask the requester for: ${missing.join(", ")}.`,
    evidence: [
      {
        label: "Incomplete request",
        detail: `Missing ${missing.join(", ")} for a ${context.request.requestType.replace(/_/g, " ")} request.`,
        source: "policy",
      },
    ],
  };
};

function toCamel(field: string): string {
  return field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The rule that carries the demo: if the team already has idle capacity of the
 * requested kind, provisioning more is waste. Ask before you buy.
 */
const reuseBeforeProvision: RuleEvaluator = (context, rule) => {
  const kinds = strArray(rule, "applies_to_kinds");
  const kind = context.request.resourceKind;
  if (!kind) return null;
  if (kinds.length > 0 && !kinds.includes(kind)) return null;
  if (context.request.requestType === "resource_reuse") return null;
  if (context.reusableResources.length === 0) return null;

  const owned = context.reusableResources.filter(
    (r) => r.owner_team_id === context.team.id,
  );
  const pool = context.reusableResources.filter(
    (r) => r.owner_team_id !== context.team.id,
  );

  const evidence: EvidenceItem[] = [
    {
      label: `${context.reusableResources.length} reusable ${kindLabel(kind, context.reusableResources.length)} available`,
      detail:
        (owned.length > 0
          ? `${owned.length} already owned by ${context.team.name} and sitting idle (${owned
              .map((r) => r.name)
              .join(", ")})`
          : "") +
        (owned.length > 0 && pool.length > 0 ? "; " : "") +
        (pool.length > 0
          ? `${pool.length} unassigned in the shared pool (${pool.map((r) => r.name).join(", ")})`
          : ""),
      source: "structured",
    },
  ];

  const target = owned[0] ?? pool[0];

  return {
    verdict: "REQUEST_INFORMATION",
    explanation:
      owned.length > 0
        ? `${context.team.name} already has ${owned.length} idle ${kindLabel(kind, owned.length)}; existing capacity must be reused before new capacity is provisioned.`
        : `${pool.length} unassigned ${kindLabel(kind, pool.length)} ${pool.length === 1 ? "is" : "are"} available in the shared pool.`,
    nextAction: target
      ? `Ask the requester whether ${target.name} can be used instead of provisioning new capacity.`
      : "Ask the requester whether existing capacity can be reused.",
    evidence,
  };
};

/**
 * Advisory: a temporary allocation about to expire is a reason to wait a day
 * rather than buy a year. Never decides on its own; it changes the framing.
 */
const expiringAllocationAwareness: RuleEvaluator = (context, rule) => {
  const withinDays = num(rule, "within_days", 7);
  const cutoff = new Date(
    context.now.getTime() + withinDays * 24 * 60 * 60 * 1000,
  );

  const relevant = context.expiringAllocations.filter((a) => {
    if (!a.expires_at) return false;
    if (new Date(a.expires_at) > cutoff) return false;
    if (!context.request.resourceKind) return true;
    return a.resource_kind === context.request.resourceKind;
  });

  if (relevant.length === 0) return null;

  return {
    verdict: null,
    explanation:
      relevant.length === 1
        ? `A temporary allocation expires within ${withinDays} days and will return capacity to the team.`
        : `${relevant.length} temporary allocations expire within ${withinDays} days and will return capacity to the team.`,
    evidence: relevant.map((a) => ({
      label: `${a.resource_name} frees up ${a.expires_at ? formatDay(new Date(a.expires_at), context.now) : "soon"}`,
      detail: `Temporary allocation${a.holder_name ? ` held by ${a.holder_name}` : ""}${a.purpose ? ` for ${a.purpose}` : ""}.`,
      source: "structured",
    })),
  };
};

/** Hard ceiling on how much of a resource kind a team may hold. */
const teamResourceCap: RuleEvaluator = (context, rule) => {
  const kind = context.request.resourceKind;
  if (kind !== "gpu") return null;

  const cap = num(rule, "gpu_cap_override", context.team.gpu_cap);
  if (cap <= 0) return null;

  const usage = usageFor(context, "gpu");
  const held = usage?.total ?? 0;
  const requested = context.request.quantity;

  if (held + requested <= cap) return null;

  return {
    verdict: "REJECT",
    explanation: `${context.team.name} holds ${held} of a maximum ${cap} GPUs; granting ${requested} more would exceed the cap.`,
    nextAction: `Cap increases are an infrastructure decision — direct the requester to raise one with the platform team.`,
    evidence: [
      {
        label: `GPU cap exceeded (${held} + ${requested} > ${cap})`,
        detail: `${context.team.name} is capped at ${cap} GPUs by organizational policy.`,
        source: "policy",
      },
    ],
  };
};

/**
 * Spend that a single agent decision may commit without a human. Anything
 * larger escalates rather than being refused — the agent is not the budget
 * owner.
 */
const budgetThreshold: RuleEvaluator = (context, rule) => {
  const cost = context.request.estimatedMonthlyCostUsd;
  if (cost === null || cost <= 0) return null;

  const unattendedLimit = num(rule, "max_unattended_monthly_usd", 500);
  const headroom = context.team.monthly_budget_usd - context.team.monthly_spend_usd;

  const overLimit = cost > unattendedLimit;
  const overBudget = cost > headroom;
  if (!overLimit && !overBudget) return null;

  const evidence: EvidenceItem[] = [];
  if (overBudget) {
    evidence.push({
      label: `Exceeds remaining budget ($${cost.toLocaleString()} > $${Math.max(headroom, 0).toLocaleString()})`,
      detail: `${context.team.name} has spent $${context.team.monthly_spend_usd.toLocaleString()} of a $${context.team.monthly_budget_usd.toLocaleString()} monthly budget.`,
      source: "structured",
    });
  }
  if (overLimit) {
    evidence.push({
      label: `Above the unattended approval limit ($${unattendedLimit.toLocaleString()}/mo)`,
      detail: `Estimated cost is $${cost.toLocaleString()}/mo; spend above the limit requires a human budget owner.`,
      source: "policy",
    });
  }

  return {
    verdict: "REQUEST_APPROVAL",
    explanation: overBudget
      ? `The request would put ${context.team.name} over its monthly budget.`
      : `The request is above the amount the agent may commit unattended.`,
    nextAction: `Escalate to the team lead for budget approval.`,
    evidence,
  };
};

/**
 * Vendor consolidation. Organizations standardise for a reason — usually a
 * painful migration nobody wants to repeat.
 */
const preferredVendor: RuleEvaluator = (context, rule) => {
  const vendor = context.request.vendor;
  if (!vendor) return null;

  const vendorCategories = record(rule, "vendor_categories");
  const preferred = record(rule, "preferred_by_category");

  const category = vendorCategories[vendor] ?? vendorCategories[vendor.toLowerCase()];
  if (!category) return null;

  const preferredVendorName = preferred[category];
  if (!preferredVendorName) return null;
  if (preferredVendorName.toLowerCase() === vendor.toLowerCase()) return null;

  return {
    verdict: "REJECT",
    explanation: `Northstar Labs standardised on ${preferredVendorName} for ${category}; ${vendor} duplicates coverage the organization already pays for.`,
    nextAction: `Point the requester at the existing ${preferredVendorName} deployment, and at the exception process if ${vendor} covers something ${preferredVendorName} genuinely cannot.`,
    evidence: [
      {
        label: `${preferredVendorName} is the standard for ${category}`,
        detail: `${vendor} is a ${category} vendor. Adding it would create a second ${category} stack.`,
        source: "policy",
      },
    ],
  };
};

/** Anything touching production gets specialist eyes before it ships. */
const productionSecurityReview: RuleEvaluator = (context, rule) => {
  const environments = strArray(rule, "environments");
  const kinds = strArray(rule, "kinds");

  const environmentMatch =
    context.request.environment !== null &&
    environments.includes(context.request.environment);
  const kindMatch =
    context.request.resourceKind !== null &&
    kinds.includes(context.request.resourceKind);

  if (!environmentMatch && !kindMatch) return null;

  return {
    verdict: "FLAG_FOR_REVIEW",
    explanation: `Production-facing changes require Security review before they are actioned.`,
    nextAction: `Route to the Security team for review.`,
    evidence: [
      {
        label: "Production-facing change",
        detail: environmentMatch
          ? `Target environment is ${context.request.environment}.`
          : `Requested resource kind is ${context.request.resourceKind}.`,
        source: "policy",
      },
    ],
  };
};

/** Advisory: the organization has already answered a version of this question. */
const duplicateRecentRequest: RuleEvaluator = (context, rule) => {
  const lookbackDays = num(rule, "lookback_days", 30);
  const cutoff = new Date(
    context.now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  );

  const resolved = context.priorRequests.filter(
    (r) =>
      new Date(r.created_at) >= cutoff &&
      r.decision !== null &&
      r.id !== context.request.id,
  );
  if (resolved.length === 0) return null;

  return {
    verdict: null,
    explanation: `${resolved.length} comparable request${resolved.length === 1 ? "" : "s"} were already decided in the last ${lookbackDays} days.`,
    evidence: resolved.slice(0, 3).map((r) => ({
      label: `${r.reference} — ${r.decision}`,
      detail: `"${r.title}" by ${r.requester_name}, ${new Date(r.created_at).toISOString().slice(0, 10)}.`,
      source: "structured",
    })),
  };
};

// ---------------------------------------------------------------------------

/**
 * Registry keyed by `policies.key`. A policy row with no evaluator here is
 * reported as unevaluated rather than silently ignored — a rule that looks
 * enforced but is not is worse than no rule.
 */
export const RULE_EVALUATORS: Readonly<Record<string, RuleEvaluator>> = {
  "missing-information": missingInformation,
  "reuse-before-provision": reuseBeforeProvision,
  "expiring-allocation-awareness": expiringAllocationAwareness,
  "team-resource-cap": teamResourceCap,
  "budget-threshold": budgetThreshold,
  "preferred-vendor": preferredVendor,
  "production-security-review": productionSecurityReview,
  "duplicate-recent-request": duplicateRecentRequest,
};

export type { RuleOutcome };

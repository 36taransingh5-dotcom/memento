import { describe, expect, it } from "vitest";
import { evaluatePolicies, reconcile } from "@/lib/policy/engine";
import { RULE_EVALUATORS } from "@/lib/policy/rules";
import type {
  PolicyContext,
  RequestFacts,
} from "@/lib/policy/types";
import type { Policy, ResourceWithContext, Team, UserWithTeam } from "@/lib/db/types";

/** Every evaluator under test is a real, registered key — assert that once here. */
function evaluator(key: keyof typeof RULE_EVALUATORS): (typeof RULE_EVALUATORS)[typeof key] {
  const found = RULE_EVALUATORS[key];
  if (!found) throw new Error(`No evaluator registered for "${key}"`);
  return found;
}

/**
 * The policy engine is the one piece of Memento that is deliberately *not*
 * LLM-shaped: pure functions of a materialised context, same input always
 * producing the same verdict. That's what makes it trustworthy enough to
 * override the model — and what makes it fast to test without a database
 * or a Bedrock credential.
 */

const NOW = new Date("2026-08-18T12:00:00Z");

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: "team-ai-research",
    key: "ai-research",
    name: "AI Research",
    description: "",
    monthly_budget_usd: 50_000,
    monthly_spend_usd: 10_000,
    gpu_cap: 6,
    created_at: NOW,
    ...overrides,
  };
}

function requester(overrides: Partial<UserWithTeam> = {}): UserWithTeam {
  return {
    id: "user-alex",
    email: "alex.chen@northstarlabs.io",
    name: "Alex Chen",
    title: "ML Engineer",
    team_id: "team-ai-research",
    role: "member",
    created_at: NOW,
    team_name: "AI Research",
    team_key: "ai-research",
    ...overrides,
  };
}

function request(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    id: "req-1",
    reference: "REQ-1000",
    title: "Another GPU for computer vision",
    body: "I need another GPU for my computer vision experiment.",
    requestType: "resource_provision",
    resourceKind: "gpu",
    quantity: 1,
    estimatedMonthlyCostUsd: null,
    vendor: null,
    environment: null,
    durationDays: null,
    ...overrides,
  };
}

function idleGpu(overrides: Partial<ResourceWithContext> = {}): ResourceWithContext {
  return {
    id: "res-gpu-2",
    key: "gpu-a100-02",
    name: "A100 80GB #02",
    kind: "gpu",
    specification: {},
    vendor: "NVIDIA",
    monthly_cost_usd: 1_800,
    owner_team_id: "team-ai-research",
    status: "idle",
    utilization_percent: 0,
    region: "us-east-1",
    created_at: NOW,
    updated_at: NOW,
    owner_team_name: "AI Research",
    active_allocation_id: null,
    allocation_type: null,
    allocation_expires_at: null,
    allocation_holder: null,
    allocation_purpose: null,
    ...overrides,
  };
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    request: request(),
    requester: requester(),
    team: team(),
    teamUsage: [],
    reusableResources: [],
    expiringAllocations: [],
    priorRequests: [],
    now: NOW,
    ...overrides,
  };
}

function policy(key: string, overrides: Partial<Policy> = {}): Policy {
  return {
    id: `policy-${key}`,
    key,
    name: key,
    description: "",
    category: "resource",
    severity: "hard",
    effect: "reject",
    rule: {},
    enabled: true,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("reuse-before-provision", () => {
  it("asks the requester to reuse idle capacity instead of provisioning", () => {
    const outcome = evaluator("reuse-before-provision")(
      context({ reusableResources: [idleGpu()] }),
      {},
    );
    expect(outcome?.verdict).toBe("REQUEST_INFORMATION");
    expect(outcome?.nextAction).toContain("A100 80GB #02");
  });

  it("does not fire when nothing is idle", () => {
    const outcome = evaluator("reuse-before-provision")(context(), {});
    expect(outcome).toBeNull();
  });

  it("does not fire on a request that is itself the reuse confirmation", () => {
    const outcome = evaluator("reuse-before-provision")(
      context({
        request: request({ requestType: "resource_reuse" }),
        reusableResources: [idleGpu()],
      }),
      {},
    );
    expect(outcome).toBeNull();
  });

  it("respects an applies_to_kinds allowlist", () => {
    const outcome = evaluator("reuse-before-provision")(
      context({ reusableResources: [idleGpu()] }),
      { applies_to_kinds: ["cloud_instance"] },
    );
    expect(outcome).toBeNull();
  });
});

describe("team-resource-cap", () => {
  it("rejects when the request would push the team over its GPU cap", () => {
    const outcome = evaluator("team-resource-cap")(
      context({
        team: team({ gpu_cap: 4 }),
        teamUsage: [{ kind: "gpu", total: 4, in_use: 4, idle: 0, monthly_cost_usd: 7_200 }],
        request: request({ quantity: 1 }),
      }),
      {},
    );
    expect(outcome?.verdict).toBe("REJECT");
    expect(outcome?.explanation).toContain("4");
  });

  it("allows a request that stays within the cap", () => {
    const outcome = evaluator("team-resource-cap")(
      context({
        team: team({ gpu_cap: 4 }),
        teamUsage: [{ kind: "gpu", total: 2, in_use: 2, idle: 0, monthly_cost_usd: 3_600 }],
      }),
      {},
    );
    expect(outcome).toBeNull();
  });

  it("ignores a per-team override in the rule payload", () => {
    const outcome = evaluator("team-resource-cap")(
      context({
        team: team({ gpu_cap: 4 }),
        teamUsage: [{ kind: "gpu", total: 5, in_use: 5, idle: 0, monthly_cost_usd: 9_000 }],
      }),
      { gpu_cap_override: 10 },
    );
    expect(outcome).toBeNull();
  });
});

describe("budget-threshold", () => {
  it("escalates rather than rejecting when spend exceeds the unattended limit", () => {
    const outcome = evaluator("budget-threshold")(
      context({
        request: request({ estimatedMonthlyCostUsd: 1_200 }),
        team: team({ monthly_budget_usd: 50_000, monthly_spend_usd: 1_000 }),
      }),
      { max_unattended_monthly_usd: 500 },
    );
    expect(outcome?.verdict).toBe("REQUEST_APPROVAL");
  });

  it("does not fire under the limit and within budget", () => {
    const outcome = evaluator("budget-threshold")(
      context({ request: request({ estimatedMonthlyCostUsd: 100 }) }),
      { max_unattended_monthly_usd: 500 },
    );
    expect(outcome).toBeNull();
  });
});

describe("missing-information", () => {
  it("asks for a required field the request type is missing", () => {
    const outcome = evaluator("missing-information")(
      context({ request: request({ resourceKind: null, requestType: "resource_provision" }) }),
      { required_by_type: { resource_provision: ["resource_kind"] } },
    );
    expect(outcome?.verdict).toBe("REQUEST_INFORMATION");
    expect(outcome?.evidence[0]?.detail).toContain("resource_kind");
  });

  it("passes once the field is present", () => {
    const outcome = evaluator("missing-information")(
      context({ request: request({ resourceKind: "gpu" }) }),
      { required_by_type: { resource_provision: ["resource_kind"] } },
    );
    expect(outcome).toBeNull();
  });
});

describe("evaluatePolicies", () => {
  it("lets a hard REJECT win outright over a softer verdict from another rule", () => {
    const evaluation = evaluatePolicies(
      context({
        team: team({ gpu_cap: 2 }),
        teamUsage: [{ kind: "gpu", total: 2, in_use: 2, idle: 0, monthly_cost_usd: 3_600 }],
        reusableResources: [idleGpu()],
      }),
      [
        policy("reuse-before-provision", { severity: "soft" }),
        policy("team-resource-cap", { severity: "hard" }),
      ],
    );
    expect(evaluation.verdict).toBe("REJECT");
    expect(evaluation.mandatory).toBe(true);
  });

  it("surfaces a policy with no registered evaluator instead of silently skipping it", () => {
    const evaluation = evaluatePolicies(context(), [policy("not-a-real-rule")]);
    expect(evaluation.triggered[0]?.explanation).toContain("NOT enforced");
    expect(evaluation.evaluatedKeys).not.toContain("not-a-real-rule");
  });

  it("records nothing when no policy fires", () => {
    const evaluation = evaluatePolicies(context(), [
      policy("team-resource-cap"),
    ]);
    expect(evaluation.verdict).toBeNull();
    expect(evaluation.evaluatedKeys).toEqual(["team-resource-cap"]);
  });
});

describe("reconcile", () => {
  it("lets the model's decision stand when no policy has an opinion", () => {
    const result = reconcile("APPROVE", {
      triggered: [],
      evidence: [],
      verdict: null,
      mandatory: false,
      nextAction: "",
      evaluatedKeys: [],
    });
    expect(result).toEqual({ decision: "APPROVE", overrodeModel: false, reason: null });
  });

  it("overrides a laxer model decision when policy is mandatory", () => {
    const result = reconcile("APPROVE", {
      triggered: [],
      evidence: [],
      verdict: "REJECT",
      mandatory: true,
      nextAction: "",
      evaluatedKeys: [],
    });
    expect(result.decision).toBe("REJECT");
    expect(result.overrodeModel).toBe(true);
  });

  it("lets the model be stricter than an advisory verdict without overriding", () => {
    const result = reconcile("REJECT", {
      triggered: [],
      evidence: [],
      verdict: "REQUEST_APPROVAL",
      mandatory: false,
      nextAction: "",
      evaluatedKeys: [],
    });
    expect(result).toEqual({ decision: "REJECT", overrodeModel: false, reason: null });
  });

  it("overrides an advisory verdict when the model is laxer, not stricter", () => {
    const result = reconcile("APPROVE", {
      triggered: [],
      evidence: [],
      verdict: "REQUEST_APPROVAL",
      mandatory: false,
      nextAction: "",
      evaluatedKeys: [],
    });
    expect(result.decision).toBe("REQUEST_APPROVAL");
    expect(result.overrodeModel).toBe(true);
  });

  it("falls back to REQUEST_INFORMATION when the model returns nothing and policy is silent", () => {
    const result = reconcile(null, {
      triggered: [],
      evidence: [],
      verdict: null,
      mandatory: false,
      nextAction: "",
      evaluatedKeys: [],
    });
    expect(result.decision).toBe("REQUEST_INFORMATION");
  });
});

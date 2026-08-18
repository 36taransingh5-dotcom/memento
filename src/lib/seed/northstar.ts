import type {
  MemoryType,
  PolicyCategory,
  PolicyEffect,
  PolicySeverity,
  RequestType,
  ResourceKind,
  ResourceStatus,
  Role,
} from "@/lib/db/types";

/**
 * Northstar Labs — the fictional organization Memento operates for.
 *
 * The data is shaped around one question: what does an agent need to *remember*
 * in order to answer "can I have another GPU?" correctly? The AI Research team
 * owns four A100s. Two sit idle. A third is on a temporary allocation that
 * expires tomorrow. A near-identical request last month was resolved by reuse.
 * None of that is in the request itself — all of it changes the answer.
 */

export interface SeedTeam {
  key: string;
  name: string;
  description: string;
  monthlyBudgetUsd: number;
  monthlySpendUsd: number;
  gpuCap: number;
}

export const TEAMS: readonly SeedTeam[] = [
  {
    key: "ai-research",
    name: "AI Research",
    description:
      "Foundation model pretraining, computer vision, and applied research. Largest GPU consumer in the organization.",
    monthlyBudgetUsd: 45_000,
    monthlySpendUsd: 38_200,
    gpuCap: 6,
  },
  {
    key: "engineering",
    name: "Engineering",
    description:
      "Production platform, APIs, and developer infrastructure. Owns the production environment.",
    monthlyBudgetUsd: 60_000,
    monthlySpendUsd: 41_500,
    gpuCap: 2,
  },
  {
    key: "product",
    name: "Product",
    description: "Product management, design, and customer research.",
    monthlyBudgetUsd: 18_000,
    monthlySpendUsd: 12_400,
    gpuCap: 0,
  },
  {
    key: "security",
    name: "Security",
    description:
      "Application and infrastructure security. Reviews anything touching the production data plane.",
    monthlyBudgetUsd: 22_000,
    monthlySpendUsd: 15_900,
    gpuCap: 0,
  },
] as const;

export interface SeedUser {
  email: string;
  name: string;
  title: string;
  teamKey: string;
  role: Role;
}

export const USERS: readonly SeedUser[] = [
  {
    email: "alex.chen@northstarlabs.io",
    name: "Alex Chen",
    title: "Senior ML Engineer",
    teamKey: "ai-research",
    role: "member",
  },
  {
    email: "priya.raman@northstarlabs.io",
    name: "Priya Raman",
    title: "Director of AI Research",
    teamKey: "ai-research",
    role: "lead",
  },
  {
    email: "maya.patel@northstarlabs.io",
    name: "Maya Patel",
    title: "Staff Infrastructure Engineer",
    teamKey: "engineering",
    role: "lead",
  },
  {
    email: "daniel.kim@northstarlabs.io",
    name: "Daniel Kim",
    title: "Product Manager",
    teamKey: "product",
    role: "member",
  },
  {
    email: "sarah.wilson@northstarlabs.io",
    name: "Sarah Wilson",
    title: "Head of Security",
    teamKey: "security",
    role: "admin",
  },
] as const;

export interface SeedResource {
  key: string;
  name: string;
  kind: ResourceKind;
  specification: Record<string, unknown>;
  vendor: string | null;
  monthlyCostUsd: number;
  ownerTeamKey: string | null;
  status: ResourceStatus;
  utilizationPercent: number;
  region: string;
}

export const RESOURCES: readonly SeedResource[] = [
  // --- The four A100s at the centre of the demo ---------------------------
  {
    key: "gpu-a100-01",
    name: "A100 80GB #01",
    kind: "gpu",
    specification: { model: "NVIDIA A100", memory_gb: 80, interconnect: "NVLink" },
    vendor: "AWS",
    monthlyCostUsd: 2_400,
    ownerTeamKey: "ai-research",
    status: "in_use",
    utilizationPercent: 94,
    region: "us-east-1",
  },
  {
    key: "gpu-a100-02",
    name: "A100 80GB #02",
    kind: "gpu",
    specification: { model: "NVIDIA A100", memory_gb: 80, interconnect: "NVLink" },
    vendor: "AWS",
    monthlyCostUsd: 2_400,
    ownerTeamKey: "ai-research",
    status: "idle",
    utilizationPercent: 0,
    region: "us-east-1",
  },
  {
    key: "gpu-a100-03",
    name: "A100 80GB #03",
    kind: "gpu",
    specification: { model: "NVIDIA A100", memory_gb: 80, interconnect: "NVLink" },
    vendor: "AWS",
    monthlyCostUsd: 2_400,
    ownerTeamKey: "ai-research",
    status: "in_use",
    utilizationPercent: 21,
    region: "us-east-1",
  },
  {
    key: "gpu-a100-04",
    name: "A100 80GB #04",
    kind: "gpu",
    specification: { model: "NVIDIA A100", memory_gb: 80, interconnect: "NVLink" },
    vendor: "AWS",
    monthlyCostUsd: 2_400,
    ownerTeamKey: "ai-research",
    status: "idle",
    utilizationPercent: 0,
    region: "us-east-1",
  },
  {
    key: "gpu-h100-01",
    name: "H100 #01",
    kind: "gpu",
    specification: { model: "NVIDIA H100", memory_gb: 80 },
    vendor: "AWS",
    monthlyCostUsd: 4_100,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 71,
    region: "us-east-1",
  },

  // --- Cloud instances -----------------------------------------------------
  {
    key: "ec2-ml-train-01",
    name: "ML training node",
    kind: "cloud_instance",
    specification: { instance_type: "p4d.24xlarge", vcpus: 96 },
    vendor: "AWS",
    monthlyCostUsd: 890,
    ownerTeamKey: "ai-research",
    status: "in_use",
    utilizationPercent: 68,
    region: "us-east-1",
  },
  {
    key: "ec2-api-prod-01",
    name: "Production API node 01",
    kind: "cloud_instance",
    specification: { instance_type: "c6i.4xlarge", vcpus: 16 },
    vendor: "AWS",
    monthlyCostUsd: 1_250,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 62,
    region: "us-east-1",
  },
  {
    key: "ec2-api-prod-02",
    name: "Production API node 02",
    kind: "cloud_instance",
    specification: { instance_type: "c6i.4xlarge", vcpus: 16 },
    vendor: "AWS",
    monthlyCostUsd: 1_250,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 58,
    region: "us-east-1",
  },
  {
    key: "ec2-batch-pool-01",
    name: "Batch pool node",
    kind: "cloud_instance",
    specification: { instance_type: "m6i.2xlarge", vcpus: 8 },
    vendor: "AWS",
    monthlyCostUsd: 640,
    // Deliberately unassigned: shared capacity anyone can claim.
    ownerTeamKey: null,
    status: "available",
    utilizationPercent: 0,
    region: "us-east-1",
  },

  // --- SaaS ---------------------------------------------------------------
  {
    key: "saas-datadog",
    name: "Datadog Pro (60 seats)",
    kind: "saas_license",
    specification: { seats: 60, tier: "Pro" },
    vendor: "Datadog",
    monthlyCostUsd: 4_800,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 83,
    region: "global",
  },
  {
    key: "saas-figma",
    name: "Figma Organization (25 seats)",
    kind: "saas_license",
    specification: { seats: 25, tier: "Organization" },
    vendor: "Figma",
    monthlyCostUsd: 1_125,
    ownerTeamKey: "product",
    status: "in_use",
    utilizationPercent: 76,
    region: "global",
  },
  {
    key: "saas-linear",
    name: "Linear Business (80 seats)",
    kind: "saas_license",
    specification: { seats: 80, tier: "Business" },
    vendor: "Linear",
    monthlyCostUsd: 1_280,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 91,
    region: "global",
  },
  {
    key: "saas-snowflake",
    name: "Snowflake credits",
    kind: "saas_license",
    specification: { edition: "Enterprise" },
    vendor: "Snowflake",
    monthlyCostUsd: 6_200,
    ownerTeamKey: "ai-research",
    status: "in_use",
    utilizationPercent: 88,
    region: "us-east-1",
  },

  // --- Production services -------------------------------------------------
  {
    key: "svc-datadog-apm",
    name: "Datadog APM",
    kind: "production_service",
    specification: { scope: "all production services" },
    vendor: "Datadog",
    monthlyCostUsd: 2_100,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 100,
    region: "global",
  },
  {
    key: "svc-pagerduty",
    name: "PagerDuty on-call",
    kind: "production_service",
    specification: { schedules: 6 },
    vendor: "PagerDuty",
    monthlyCostUsd: 780,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 100,
    region: "global",
  },
  {
    key: "svc-sentry",
    name: "Sentry error tracking",
    kind: "production_service",
    specification: { projects: 22 },
    vendor: "Sentry",
    monthlyCostUsd: 540,
    ownerTeamKey: "engineering",
    status: "in_use",
    utilizationPercent: 100,
    region: "global",
  },
] as const;

export interface SeedPolicy {
  key: string;
  name: string;
  description: string;
  category: PolicyCategory;
  severity: PolicySeverity;
  effect: PolicyEffect;
  rule: Record<string, unknown>;
}

/**
 * Every key here has a matching evaluator in src/lib/policy/rules.ts. A policy
 * without one is reported as "documented but NOT enforced" rather than silently
 * passing — see evaluatePolicies().
 */
export const POLICIES: readonly SeedPolicy[] = [
  {
    key: "reuse-before-provision",
    name: "Reuse existing capacity before provisioning",
    description:
      "If the requesting team already owns idle capacity of the requested kind, or unassigned capacity exists in the shared pool, the requester must be offered it before anything new is provisioned.",
    category: "resource",
    severity: "hard",
    effect: "request_information",
    rule: { applies_to_kinds: ["gpu", "cloud_instance", "saas_license"] },
  },
  {
    key: "team-resource-cap",
    name: "Team GPU cap",
    description:
      "No team may hold more GPUs than its configured cap. Cap increases are an infrastructure decision, not an agent decision.",
    category: "resource",
    severity: "hard",
    effect: "reject",
    rule: {},
  },
  {
    key: "budget-threshold",
    name: "Unattended spend limit",
    description:
      "The agent may commit up to $500/month without a human. Anything larger, or anything exceeding the team's remaining monthly budget, escalates to the team lead.",
    category: "budget",
    severity: "hard",
    effect: "require_approval",
    rule: { max_unattended_monthly_usd: 500 },
  },
  {
    key: "preferred-vendor",
    name: "Vendor consolidation",
    description:
      "Northstar Labs standardised on one vendor per category. Requests for a competing vendor in a category we already cover are rejected, with an exception process available through the Head of Security.",
    category: "vendor",
    severity: "hard",
    effect: "reject",
    rule: {
      preferred_by_category: {
        observability: "Datadog",
        incident_response: "PagerDuty",
        error_tracking: "Sentry",
        design: "Figma",
      },
      vendor_categories: {
        Datadog: "observability",
        "New Relic": "observability",
        "Grafana Cloud": "observability",
        Splunk: "observability",
        Dynatrace: "observability",
        PagerDuty: "incident_response",
        Opsgenie: "incident_response",
        Sentry: "error_tracking",
        Bugsnag: "error_tracking",
        Figma: "design",
        Sketch: "design",
      },
    },
  },
  {
    key: "production-security-review",
    name: "Security review for production changes",
    description:
      "Anything targeting the production environment, or adding a production service, is reviewed by the Security team before it is actioned.",
    category: "security",
    severity: "hard",
    effect: "flag_for_review",
    rule: {
      environments: ["production"],
      kinds: ["production_service"],
    },
  },
  {
    key: "missing-information",
    name: "Complete requests only",
    description:
      "A request missing a field the organization needs in order to decide is returned to the requester rather than guessed at.",
    category: "process",
    severity: "hard",
    effect: "request_information",
    rule: {
      required_by_type: {
        saas_license: ["vendor"],
        service_addition: ["environment"],
      },
    },
  },
  {
    key: "expiring-allocation-awareness",
    name: "Account for expiring allocations",
    description:
      "Capacity returning to the pool within two weeks counts as available when assessing whether new capacity is genuinely needed. Advisory: it informs the decision rather than dictating it.",
    category: "resource",
    severity: "soft",
    effect: "advisory",
    rule: { within_days: 14 },
  },
  {
    key: "duplicate-recent-request",
    name: "Surface recent comparable decisions",
    description:
      "When the organization has already decided a comparable request recently, that decision is surfaced as evidence so the agent stays consistent with it.",
    category: "process",
    severity: "soft",
    effect: "advisory",
    rule: { lookback_days: 60 },
  },
] as const;

export interface SeedRequest {
  reference: string;
  requesterEmail: string;
  title: string;
  body: string;
  requestType: RequestType;
  resourceKind: ResourceKind | null;
  quantity: number;
  estimatedMonthlyCostUsd: number | null;
  vendor: string | null;
  environment: string | null;
  durationDays: number | null;
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "needs_information"
    | "under_review"
    | "withdrawn"
    | "fulfilled";
  daysAgo: number;
  decision: {
    decision:
      | "APPROVE"
      | "REJECT"
      | "REQUEST_APPROVAL"
      | "REQUEST_INFORMATION"
      | "FLAG_FOR_REVIEW";
    rationale: string;
    nextAction: string;
    policyKeys: string[];
  } | null;
}

export const REQUESTS: readonly SeedRequest[] = [
  {
    reference: "REQ-1001",
    requesterEmail: "maya.patel@northstarlabs.io",
    title: "Add New Relic for backend observability",
    body: "The backend team wants New Relic for APM on the payments service. Around $1,900/month for the tier we need.",
    requestType: "saas_license",
    resourceKind: "saas_license",
    quantity: 1,
    estimatedMonthlyCostUsd: 1_900,
    vendor: "New Relic",
    environment: null,
    durationDays: null,
    status: "rejected",
    daysAgo: 47,
    decision: {
      decision: "REJECT",
      rationale:
        "Northstar Labs standardised on Datadog for observability, and Datadog APM is already deployed across every production service including payments. Adding New Relic would create a second observability stack at $1,900/month for coverage the organization already pays for.",
      nextAction:
        "Point Maya at the existing Datadog APM deployment; route genuine gaps through the Head of Security as a vendor exception.",
      policyKeys: ["preferred-vendor"],
    },
  },
  {
    reference: "REQ-1002",
    requesterEmail: "daniel.kim@northstarlabs.io",
    title: "Five additional Figma seats for the design sprint",
    body: "We need five more Figma seats for contractors joining the Q3 design sprint. About $225/month.",
    requestType: "saas_license",
    resourceKind: "saas_license",
    quantity: 5,
    estimatedMonthlyCostUsd: 225,
    vendor: "Figma",
    environment: null,
    durationDays: null,
    status: "approved",
    daysAgo: 40,
    decision: {
      decision: "APPROVE",
      rationale:
        "Figma is the standard design tool and the organization already holds an Organization plan. At $225/month the request is inside the $500 unattended limit and Product has $5,600 of monthly budget headroom.",
      nextAction: "Provision five seats on the existing Figma Organization plan.",
      policyKeys: [],
    },
  },
  {
    reference: "REQ-1003",
    requesterEmail: "alex.chen@northstarlabs.io",
    title: "Provision two more A100s for the diffusion model run",
    body: "The diffusion model run needs more capacity. Can we get two more A100s?",
    requestType: "resource_provision",
    resourceKind: "gpu",
    quantity: 2,
    estimatedMonthlyCostUsd: 4_800,
    vendor: null,
    environment: null,
    durationDays: null,
    status: "fulfilled",
    daysAgo: 33,
    decision: {
      decision: "REQUEST_INFORMATION",
      rationale:
        "AI Research had an idle A100 at the time of the request. Provisioning two more would have taken the team to six GPUs with one unused. Reuse was offered first.",
      nextAction: "Ask Alex whether the idle A100 covers the diffusion run.",
      policyKeys: ["reuse-before-provision"],
    },
  },
  {
    reference: "REQ-1004",
    requesterEmail: "sarah.wilson@northstarlabs.io",
    title: "Add Snyk for dependency scanning",
    body: "Security needs Snyk for dependency and container scanning across the monorepo. $1,400/month.",
    requestType: "saas_license",
    resourceKind: "saas_license",
    quantity: 1,
    estimatedMonthlyCostUsd: 1_400,
    vendor: "Snyk",
    environment: null,
    durationDays: null,
    status: "approved",
    daysAgo: 26,
    decision: {
      decision: "REQUEST_APPROVAL",
      rationale:
        "No existing tool covers dependency scanning and no vendor policy applies, but $1,400/month is well above the $500 unattended limit. Escalated for budget sign-off rather than refused.",
      nextAction: "Escalate to the budget owner for approval.",
      policyKeys: ["budget-threshold"],
    },
  },
  {
    reference: "REQ-1005",
    requesterEmail: "maya.patel@northstarlabs.io",
    title: "Add Grafana Cloud as a production monitoring service",
    body: "Can we add Grafana Cloud for production dashboards? The team prefers its query language.",
    requestType: "service_addition",
    resourceKind: "production_service",
    quantity: 1,
    estimatedMonthlyCostUsd: 1_100,
    vendor: "Grafana Cloud",
    environment: "production",
    durationDays: null,
    status: "rejected",
    daysAgo: 19,
    decision: {
      decision: "REJECT",
      rationale:
        "Grafana Cloud is an observability vendor and Datadog is the organizational standard, already covering production dashboards. A tooling preference is not grounds for a second observability stack.",
      nextAction:
        "Offer to rebuild the requested dashboards in Datadog; route a genuine capability gap through the vendor exception process.",
      policyKeys: ["preferred-vendor", "production-security-review"],
    },
  },
  {
    reference: "REQ-1006",
    requesterEmail: "daniel.kim@northstarlabs.io",
    title: "Read access to the analytics warehouse",
    body: "I need read access to the Snowflake analytics warehouse for the retention analysis.",
    requestType: "access",
    resourceKind: null,
    quantity: 1,
    estimatedMonthlyCostUsd: null,
    vendor: null,
    environment: null,
    durationDays: null,
    status: "approved",
    daysAgo: 12,
    decision: {
      decision: "APPROVE",
      rationale:
        "Read access to the analytics warehouse is standard for product managers, carries no incremental cost, and touches no production data plane.",
      nextAction: "Grant read-only warehouse access to Daniel Kim.",
      policyKeys: [],
    },
  },
  {
    reference: "REQ-1007",
    requesterEmail: "alex.chen@northstarlabs.io",
    title: "Temporary GPU for the computer vision experiment",
    body: "I need one A100 for about a week to run the computer vision experiment for the object detection paper.",
    requestType: "resource_provision",
    resourceKind: "gpu",
    quantity: 1,
    estimatedMonthlyCostUsd: 2_400,
    vendor: null,
    environment: null,
    durationDays: 7,
    status: "fulfilled",
    daysAgo: 6,
    decision: {
      decision: "APPROVE",
      rationale:
        "AI Research was two GPUs below its cap and the experiment was scoped to a week. Approved as a temporary seven-day allocation on gpu-a100-03 rather than a permanent one, so the capacity returns automatically.",
      nextAction: "Allocate gpu-a100-03 to Alex Chen for seven days.",
      policyKeys: [],
    },
  },
  {
    reference: "REQ-1008",
    requesterEmail: "maya.patel@northstarlabs.io",
    title: "Scale the production API to a third node",
    body: "p99 latency is climbing on the production API. We want to add a third c6i.4xlarge node in us-east-1.",
    requestType: "resource_provision",
    resourceKind: "cloud_instance",
    quantity: 1,
    estimatedMonthlyCostUsd: 1_250,
    vendor: "AWS",
    environment: "production",
    durationDays: null,
    status: "under_review",
    daysAgo: 4,
    decision: {
      decision: "FLAG_FOR_REVIEW",
      rationale:
        "Adding a node behind the production API changes the production data plane, which requires Security review before it is actioned. The capacity case itself is sound — p99 latency is documented and Engineering has budget headroom.",
      nextAction: "Route to the Security team for production data-plane review.",
      policyKeys: ["production-security-review", "budget-threshold"],
    },
  },
] as const;

export interface SeedMemory {
  content: string;
  summary: string;
  memoryType: MemoryType;
  importance: number;
  daysAgo: number;
  sourceRequestRef: string | null;
  subjectTeamKey: string | null;
  subjectUserEmail: string | null;
  subjectResourceKey: string | null;
  /** Days from now until the memory goes stale, or null if it does not. */
  expiresInDays: number | null;
}

/**
 * The semantic layer. These are written the way a colleague would write a note
 * to their future self: self-contained, naming the specific people, resources
 * and dates, so they still mean something a year later out of context.
 */
export const MEMORIES: readonly SeedMemory[] = [
  {
    content:
      "Alex Chen requested a temporary GPU allocation for a computer vision experiment supporting the object detection paper. Memento approved it as a seven-day allocation on gpu-a100-03 rather than provisioning permanent capacity, so the GPU returns to the AI Research pool automatically when the experiment ends.",
    summary: "Alex Chen's temporary GPU approved for the computer vision experiment",
    memoryType: "decision",
    importance: 4,
    daysAgo: 6,
    sourceRequestRef: "REQ-1007",
    subjectTeamKey: "ai-research",
    subjectUserEmail: "alex.chen@northstarlabs.io",
    subjectResourceKey: "gpu-a100-03",
    expiresInDays: null,
  },
  {
    content:
      "The temporary allocation on gpu-a100-03, held by Alex Chen for the computer vision experiment, expires tomorrow and returns a third idle A100 to the AI Research pool. Any GPU request from AI Research before then should account for that capacity arriving.",
    summary: "gpu-a100-03 frees up tomorrow when Alex Chen's temporary allocation expires",
    memoryType: "expiration",
    importance: 5,
    daysAgo: 6,
    sourceRequestRef: "REQ-1007",
    subjectTeamKey: "ai-research",
    subjectUserEmail: "alex.chen@northstarlabs.io",
    subjectResourceKey: "gpu-a100-03",
    expiresInDays: 3,
  },
  {
    content:
      "The AI Research team asked for two additional A100 GPUs for a diffusion model run. Memento found an idle A100 the team already owned and asked whether it could be reused first. Alex Chen reused gpu-a100-02 and the additional capacity was never provisioned, saving roughly $4,800 per month.",
    summary: "AI Research GPU request resolved by reuse instead of provisioning",
    memoryType: "outcome",
    importance: 5,
    daysAgo: 33,
    sourceRequestRef: "REQ-1003",
    subjectTeamKey: "ai-research",
    subjectUserEmail: "alex.chen@northstarlabs.io",
    subjectResourceKey: "gpu-a100-02",
    expiresInDays: null,
  },
  {
    content:
      "Northstar Labs standardised on Datadog for observability after consolidating three monitoring vendors during the Q1 tooling review. Adding a second observability or monitoring stack requires a written exception approved by Sarah Wilson, the Head of Security.",
    summary: "Datadog is the organizational standard for observability and monitoring",
    memoryType: "preference",
    importance: 5,
    daysAgo: 120,
    sourceRequestRef: null,
    subjectTeamKey: null,
    subjectUserEmail: null,
    subjectResourceKey: "saas-datadog",
    expiresInDays: null,
  },
  {
    content:
      "Maya Patel's request to add New Relic for backend APM was rejected because Datadog APM already covers the payments service and every other production service. The rejection was about duplicate coverage, not about New Relic's capabilities.",
    summary: "New Relic rejected — Datadog already covers backend APM",
    memoryType: "decision",
    importance: 4,
    daysAgo: 47,
    sourceRequestRef: "REQ-1001",
    subjectTeamKey: "engineering",
    subjectUserEmail: "maya.patel@northstarlabs.io",
    subjectResourceKey: null,
    expiresInDays: null,
  },
  {
    content:
      "A request to add Grafana Cloud as a production monitoring service was rejected because its dashboards duplicate Datadog, which is already deployed across production. The team's stated reason was a preference for Grafana's query language rather than a capability gap.",
    summary: "Grafana Cloud rejected as a duplicate production monitoring stack",
    memoryType: "decision",
    importance: 4,
    daysAgo: 19,
    sourceRequestRef: "REQ-1005",
    subjectTeamKey: "engineering",
    subjectUserEmail: "maya.patel@northstarlabs.io",
    subjectResourceKey: null,
    expiresInDays: null,
  },
  {
    content:
      "Engineering prefers AWS for production workloads. The production API runs on EC2 in us-east-1, and the team has declined two proposals to migrate parts of the platform to GCP, citing operational familiarity and existing reserved-instance commitments.",
    summary: "Engineering standardises on AWS for production workloads",
    memoryType: "preference",
    importance: 4,
    daysAgo: 90,
    sourceRequestRef: null,
    subjectTeamKey: "engineering",
    subjectUserEmail: null,
    subjectResourceKey: null,
    expiresInDays: null,
  },
  {
    content:
      "AI Research GPU spend is the single largest line item in Northstar Labs' infrastructure budget at roughly $9,600 per month for four A100s. Finance treats idle GPUs as a budget problem rather than spare capacity, which is why reuse is enforced before provisioning.",
    summary: "Idle GPUs are treated as a budget problem, not spare capacity",
    memoryType: "constraint",
    importance: 4,
    daysAgo: 75,
    sourceRequestRef: null,
    subjectTeamKey: "ai-research",
    subjectUserEmail: null,
    subjectResourceKey: null,
    expiresInDays: null,
  },
  {
    content:
      "Daniel Kim's request for five additional Figma seats was approved without escalation because the $225 monthly cost sat under the $500 unattended approval limit and Figma is the standard design tool.",
    summary: "Figma seat expansion approved under the unattended spend limit",
    memoryType: "decision",
    importance: 2,
    daysAgo: 40,
    sourceRequestRef: "REQ-1002",
    subjectTeamKey: "product",
    subjectUserEmail: "daniel.kim@northstarlabs.io",
    subjectResourceKey: "saas-figma",
    expiresInDays: null,
  },
  {
    content:
      "Sarah Wilson requires Security review for anything touching the production data plane, including new compute nodes placed behind the production API. Reviews typically complete within two business days and have not blocked a capacity request to date.",
    summary: "Security reviews every change to the production data plane",
    memoryType: "constraint",
    importance: 5,
    daysAgo: 60,
    sourceRequestRef: null,
    subjectTeamKey: "security",
    subjectUserEmail: "sarah.wilson@northstarlabs.io",
    subjectResourceKey: null,
    expiresInDays: null,
  },
  {
    content:
      "The batch pool node ec2-batch-pool-01 has been unassigned and idle since the Q2 batch migration completed. It is available to any team without a procurement step, and is the first thing to check before a new general-purpose instance is provisioned.",
    summary: "ec2-batch-pool-01 has been idle and unassigned since the Q2 migration",
    memoryType: "event",
    importance: 3,
    daysAgo: 55,
    sourceRequestRef: null,
    subjectTeamKey: null,
    subjectUserEmail: null,
    subjectResourceKey: "ec2-batch-pool-01",
    expiresInDays: null,
  },
  {
    content:
      "AI Research runs two long-lived foundation model pretraining jobs on gpu-a100-01. That GPU sits above 90 percent utilization continuously and is not a candidate for reuse, unlike the team's other A100s.",
    summary: "gpu-a100-01 is saturated by pretraining and cannot be reused",
    memoryType: "constraint",
    importance: 4,
    daysAgo: 30,
    sourceRequestRef: null,
    subjectTeamKey: "ai-research",
    subjectUserEmail: null,
    subjectResourceKey: "gpu-a100-01",
    expiresInDays: null,
  },
  {
    content:
      "Alex Chen's computer vision experiment was originally scoped at five days and extended to seven after the first training run diverged. Alex flagged at the time that a further extension might be needed for the object detection paper deadline.",
    summary: "Alex Chen's computer vision experiment already slipped from five days to seven",
    memoryType: "event",
    importance: 3,
    daysAgo: 4,
    sourceRequestRef: "REQ-1007",
    subjectTeamKey: "ai-research",
    subjectUserEmail: "alex.chen@northstarlabs.io",
    subjectResourceKey: "gpu-a100-03",
    expiresInDays: null,
  },
  {
    content:
      "Snowflake credits for AI Research were increased in Q2 after the team exhausted its quota mid-month and stalled a training pipeline. The increase was approved on the condition that usage is reviewed quarterly.",
    summary: "AI Research Snowflake quota increased in Q2 with quarterly review attached",
    memoryType: "policy_exception",
    importance: 3,
    daysAgo: 85,
    sourceRequestRef: null,
    subjectTeamKey: "ai-research",
    subjectUserEmail: null,
    subjectResourceKey: "saas-snowflake",
    expiresInDays: null,
  },
  {
    content:
      "Product's request for a second analytics vendor was withdrawn after Daniel Kim confirmed that the existing Snowflake warehouse already covered the retention analysis use case. No procurement was needed.",
    summary: "Second analytics vendor withdrawn — existing warehouse covered the use case",
    memoryType: "outcome",
    importance: 2,
    daysAgo: 21,
    sourceRequestRef: null,
    subjectTeamKey: "product",
    subjectUserEmail: "daniel.kim@northstarlabs.io",
    subjectResourceKey: null,
    expiresInDays: null,
  },
] as const;

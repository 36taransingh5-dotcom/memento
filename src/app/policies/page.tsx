import type { Metadata } from "next";
import { ConnectionError } from "@/components/ConnectionError";
import {
  Card,
  CardTitle,
  Mono,
  PageHeader,
  StatTile,
  Tag,
  cx,
} from "@/components/ui";
import { listPolicies } from "@/lib/db/repositories/policies";
import { RULE_EVALUATORS } from "@/lib/policy/rules";
import type { PolicyCategory, PolicyEffect } from "@/lib/db/types";

export const metadata: Metadata = { title: "Policies" };
export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Readonly<Record<PolicyCategory, string>> = {
  resource: "Resource",
  budget: "Budget",
  vendor: "Vendor",
  security: "Security",
  process: "Process",
};

const EFFECT_LABELS: Readonly<Record<PolicyEffect, string>> = {
  reject: "REJECT",
  require_approval: "REQUEST_APPROVAL",
  request_information: "REQUEST_INFORMATION",
  flag_for_review: "FLAG_FOR_REVIEW",
  advisory: "advisory only",
};

export default async function PoliciesPage() {
  try {
    const policies = await listPolicies({ enabledOnly: false });

    const hard = policies.filter((p) => p.severity === "hard");
    const enforced = policies.filter((p) => p.key in RULE_EVALUATORS);
    const unenforced = policies.filter((p) => !(p.key in RULE_EVALUATORS));

    const byCategory = new Map<PolicyCategory, typeof policies>();
    for (const policy of policies) {
      const bucket = byCategory.get(policy.category) ?? [];
      bucket.push(policy);
      byCategory.set(policy.category, bucket);
    }

    return (
      <>
        <PageHeader
          title="Policies"
          description="Organizational rules, evaluated deterministically in TypeScript against live data. The language model is never asked to recall a rule — only shown the verdicts these produced."
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Active policies"
            value={policies.filter((p) => p.enabled).length}
            detail={`${policies.length} defined in total`}
          />
          <StatTile
            label="Binding"
            value={hard.length}
            detail="Cannot be overridden by the model"
            tone="accent"
          />
          <StatTile
            label="Enforced"
            value={`${enforced.length}/${policies.length}`}
            detail="Have a registered evaluator"
            tone={unenforced.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Advisory"
            value={policies.filter((p) => p.effect === "advisory").length}
            detail="Shape the evidence, not the verdict"
          />
        </div>

        {unenforced.length > 0 ? (
          <Card className="mt-6 border-inform-bg">
            <CardTitle>Documented but not enforced</CardTitle>
            <p className="text-sm leading-relaxed text-ink-muted">
              {unenforced.length} polic
              {unenforced.length === 1 ? "y has" : "ies have"} no registered
              evaluator in <Mono>src/lib/policy/rules.ts</Mono>. The agent
              reports them as unenforced rather than pretending they applied — a
              rule that looks enforced but is not is worse than no rule.
            </p>
            <ul className="mt-3 space-y-1">
              {unenforced.map((policy) => (
                <li key={policy.id} className="text-xs text-inform">
                  <Mono>{policy.key}</Mono> — {policy.name}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <div className="mt-6 space-y-6">
          {[...byCategory.entries()].map(([category, items]) => (
            <div key={category}>
              <h2 className="mb-3 text-[13px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                {CATEGORY_LABELS[category]}
                <span className="ml-2 text-ink-subtle/70">{items.length}</span>
              </h2>

              <div className="space-y-3">
                {items.map((policy) => (
                  <Card key={policy.id} className={cx(!policy.enabled && "opacity-60")}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium text-ink">
                          {policy.name}
                        </h3>
                        <Mono>{policy.key}</Mono>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Tag tone={policy.severity === "hard" ? "hard" : "soft"}>
                          {policy.severity === "hard" ? "binding" : "advisory"}
                        </Tag>
                        <Tag tone="neutral">{EFFECT_LABELS[policy.effect]}</Tag>
                        {policy.key in RULE_EVALUATORS ? (
                          <Tag tone="accent">enforced</Tag>
                        ) : (
                          <Tag tone="hard">not enforced</Tag>
                        )}
                        {!policy.enabled ? <Tag tone="soft">disabled</Tag> : null}
                      </div>
                    </div>

                    <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                      {policy.description}
                    </p>

                    {Object.keys(policy.rule).length > 0 ? (
                      <details className="mt-3 border-t border-line pt-3">
                        <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle transition-colors hover:text-ink-muted">
                          Parameters
                        </summary>
                        <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
                          {JSON.stringify(policy.rule, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>

        <Card className="mt-6">
          <CardTitle>How a verdict is reached</CardTitle>
          <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
            <p>
              Every enabled policy is evaluated against the same materialised
              context: the parsed request, the requester, their team&apos;s budget
              and caps, what the team currently holds, what is idle, what expires
              soon, and comparable past requests. Rules are pure functions of that
              context — no I/O, no model, no randomness.
            </p>
            <p>
              When more than one fires, the strongest verdict wins, in the order{" "}
              <Mono>REJECT</Mono> → <Mono>REQUEST_INFORMATION</Mono> →{" "}
              <Mono>FLAG_FOR_REVIEW</Mono> → <Mono>REQUEST_APPROVAL</Mono> →{" "}
              <Mono>APPROVE</Mono>. Asking for information outranks the two
              escalations on purpose: when a free alternative exists or a fact is
              missing, resolving that is cheaper than spending a human&apos;s
              attention.
            </p>
            <p>
              A <span className="text-reject">binding</span> verdict from a hard
              policy is final. The model may choose a{" "}
              <em>stricter</em> outcome than an advisory verdict — caution is
              always allowed — but never a laxer one. Every override is recorded
              on the decision and shown in the audit log.
            </p>
          </div>
        </Card>
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Policies" />
        <ConnectionError error={error} />
      </>
    );
  }
}

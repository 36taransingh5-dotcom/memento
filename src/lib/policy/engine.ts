import type { Decision, EvidenceItem, Policy, TriggeredPolicy } from "@/lib/db/types";
import { RULE_EVALUATORS } from "@/lib/policy/rules";
import type { PolicyContext, PolicyEvaluation } from "@/lib/policy/types";

/**
 * The deterministic policy engine.
 *
 * Given a fully-materialised PolicyContext and the enabled policy rows, it
 * returns every rule that fired, the evidence they produced, and the decision
 * the organization requires. No model is involved and no I/O happens here, so
 * the same inputs always produce the same verdict — which is exactly why the
 * engine is allowed to overrule the language model.
 */

/**
 * Decision precedence, strongest first.
 *
 * REJECT is terminal, so it wins outright. REQUEST_INFORMATION sits above the
 * two escalation outcomes deliberately: when a free alternative exists or a
 * fact is missing, resolving that is cheaper than spending a human's attention,
 * and it is the outcome that turns "provision another GPU" into "reuse the one
 * you already have". FLAG_FOR_REVIEW outranks REQUEST_APPROVAL because a
 * security question should be answered before a budget one.
 */
const PRECEDENCE: readonly Decision[] = [
  "REJECT",
  "REQUEST_INFORMATION",
  "FLAG_FOR_REVIEW",
  "REQUEST_APPROVAL",
  "APPROVE",
] as const;

export function decisionRank(decision: Decision): number {
  const index = PRECEDENCE.indexOf(decision);
  return index === -1 ? PRECEDENCE.length : index;
}

/** True when `a` is at least as strong as `b`. */
export function isAtLeastAsStrict(a: Decision, b: Decision): boolean {
  return decisionRank(a) <= decisionRank(b);
}

export function evaluatePolicies(
  context: PolicyContext,
  policies: readonly Policy[],
): PolicyEvaluation {
  const triggered: TriggeredPolicy[] = [];
  const evidence: EvidenceItem[] = [];
  const evaluatedKeys: string[] = [];

  let verdict: Decision | null = null;
  let mandatory = false;
  let nextAction = "";

  for (const policy of policies) {
    if (!policy.enabled) continue;

    const evaluator = RULE_EVALUATORS[policy.key];
    if (!evaluator) {
      // Surfaced rather than swallowed: an unimplemented policy is a gap in
      // enforcement, and operators need to see it.
      triggered.push({
        key: policy.key,
        name: policy.name,
        severity: policy.severity,
        effect: policy.effect,
        verdict: null,
        explanation:
          "No evaluator is registered for this policy — it is documented but NOT enforced.",
      });
      continue;
    }

    evaluatedKeys.push(policy.key);

    let outcome;
    try {
      outcome = evaluator(context, policy.rule);
    } catch (err) {
      // A rule that throws must not take the whole evaluation down, but it also
      // must not silently pass: record it and flag for human review.
      triggered.push({
        key: policy.key,
        name: policy.name,
        severity: policy.severity,
        effect: policy.effect,
        verdict: "FLAG_FOR_REVIEW",
        explanation: `Policy evaluation failed: ${
          err instanceof Error ? err.message : String(err)
        }. Flagging for human review rather than assuming compliance.`,
      });
      if (verdict === null || !isAtLeastAsStrict(verdict, "FLAG_FOR_REVIEW")) {
        verdict = "FLAG_FOR_REVIEW";
        mandatory = true;
        nextAction = "A policy could not be evaluated — review manually.";
      }
      continue;
    }

    if (!outcome) continue;

    triggered.push({
      key: policy.key,
      name: policy.name,
      severity: policy.severity,
      effect: policy.effect,
      verdict: outcome.verdict,
      explanation: outcome.explanation,
    });
    evidence.push(...outcome.evidence);

    if (!outcome.verdict) continue;

    const strongerThanCurrent =
      verdict === null || isAtLeastAsStrict(outcome.verdict, verdict);

    // A hard policy always claims the verdict from a soft one at equal strength.
    const outranksBySeverity =
      verdict !== null &&
      outcome.verdict === verdict &&
      policy.severity === "hard" &&
      !mandatory;

    if (strongerThanCurrent || outranksBySeverity) {
      // Never let a soft policy weaken a hard verdict already in place.
      if (mandatory && policy.severity === "soft" && outcome.verdict !== verdict) {
        continue;
      }
      verdict = outcome.verdict;
      mandatory = policy.severity === "hard";
      nextAction = outcome.nextAction ?? nextAction;
    }
  }

  return { triggered, evidence, verdict, mandatory, nextAction, evaluatedKeys };
}

export interface Reconciliation {
  decision: Decision;
  overrodeModel: boolean;
  reason: string | null;
}

/**
 * Reconcile the model's proposed decision with the deterministic verdict.
 *
 * The model interprets context; the policy engine decides what is permitted.
 * When a `hard` policy produced a verdict, that verdict stands regardless of
 * what the model proposed. When the engine's verdict is advisory, the model may
 * choose a *stricter* outcome — caution is always allowed — but not a laxer one.
 */
export function reconcile(
  modelDecision: Decision | null,
  evaluation: PolicyEvaluation,
): Reconciliation {
  const { verdict, mandatory } = evaluation;

  if (!modelDecision) {
    return {
      decision: verdict ?? "REQUEST_INFORMATION",
      overrodeModel: false,
      reason: verdict
        ? null
        : "The model did not return a decision; defaulting to asking the requester for detail.",
    };
  }

  if (!verdict) {
    return { decision: modelDecision, overrodeModel: false, reason: null };
  }

  if (modelDecision === verdict) {
    return { decision: modelDecision, overrodeModel: false, reason: null };
  }

  if (mandatory) {
    return {
      decision: verdict,
      overrodeModel: true,
      reason:
        `A hard policy requires ${verdict}; the model proposed ${modelDecision}. ` +
        `Deterministic policy takes precedence.`,
    };
  }

  // Advisory verdict: allow the model to be stricter, never laxer.
  if (isAtLeastAsStrict(modelDecision, verdict)) {
    return { decision: modelDecision, overrodeModel: false, reason: null };
  }

  return {
    decision: verdict,
    overrodeModel: true,
    reason:
      `Policy guidance is ${verdict} and the model proposed the less cautious ${modelDecision}. ` +
      `The more conservative outcome was applied.`,
  };
}

export type { PolicyContext, PolicyEvaluation };

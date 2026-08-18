import Link from "next/link";
import { PipelineTrace } from "@/components/PipelineTrace";
import {
  Card,
  CardTitle,
  DecisionBadge,
  Mono,
  Tag,
  cx,
  formatRelative,
} from "@/components/ui";
import type { AgentRunResult } from "@/lib/agent/types";

/**
 * The auditable decision trace.
 *
 * Deliberately *not* a reasoning dump: it shows the evidence the decision rests
 * on, the policies that fired, the memories retrieved with their similarity
 * scores, and the tools that ran. A reviewer can reconstruct why the agent
 * decided what it decided without ever seeing its private chain of thought.
 */
export function DecisionTrace({ run }: { run: AgentRunResult }) {
  return (
    <div className="space-y-4">
      {run.degradedReason ? (
        <div className="rounded-lg border border-inform-bg bg-inform-bg/40 px-4 py-3">
          <p className="text-xs font-medium text-inform">Degraded reasoning</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {run.degradedReason}
          </p>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <DecisionBadge decision={run.decision} size="lg" />
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-subtle">
            <Tag tone={run.reasoningProvider === "bedrock" ? "accent" : "soft"}>
              {run.reasoningProvider === "bedrock"
                ? `bedrock · ${run.model}`
                : "deterministic policy engine"}
            </Tag>
            <span>confidence {run.confidence}</span>
            <span aria-hidden>·</span>
            <span>{run.latencyMs}ms</span>
            {run.requestReference ? (
              <Link
                href={`/requests/${run.requestId}`}
                className="text-accent-ink hover:underline"
              >
                {run.requestReference}
              </Link>
            ) : null}
          </div>
        </div>

        <p className="mt-4 text-[15px] leading-relaxed text-ink">
          {run.rationale}
        </p>

        <div className="mt-4 rounded-lg border border-line bg-canvas px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Next action
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">
            {run.nextAction}
          </p>
        </div>

        {run.policyOverrodeModel ? (
          <div className="mt-4 rounded-lg border border-reject-bg px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-reject">
              Policy overrode the model
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              {run.policyOverrideReason}
            </p>
            {run.modelProposedDecision ? (
              <p className="mt-2 text-[11px] text-ink-subtle">
                Model proposed{" "}
                <span className="font-mono">{run.modelProposedDecision}</span>,
                deterministic policy required{" "}
                <span className="font-mono">{run.decision}</span>.
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Retrieval pipeline</CardTitle>
          <PipelineTrace stages={run.pipeline} />
        </Card>

        <Card>
          <CardTitle hint={`${run.evidence.length} items`}>Evidence</CardTitle>
          {run.evidence.length === 0 ? (
            <p className="text-xs text-ink-subtle">
              No supporting evidence was recorded.
            </p>
          ) : (
            <ul className="space-y-3">
              {run.evidence.map((item, index) => (
                <li key={`${item.label}-${index}`} className="flex gap-2.5">
                  <span
                    className={cx(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      item.source === "policy" ? "bg-review" : "bg-accent",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium leading-snug text-ink">
                      {item.label}
                    </p>
                    {item.detail ? (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                        {item.detail}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle hint={`${run.policiesTriggered.length} triggered`}>
            Policies
          </CardTitle>
          {run.policiesTriggered.length === 0 ? (
            <p className="text-xs text-ink-subtle">No policy was triggered.</p>
          ) : (
            <ul className="space-y-3">
              {run.policiesTriggered.map((policy) => (
                <li key={policy.key}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-ink">
                      {policy.name}
                    </span>
                    <Tag tone={policy.severity === "hard" ? "hard" : "soft"}>
                      {policy.severity === "hard" ? "binding" : "advisory"}
                    </Tag>
                    {policy.verdict ? (
                      <Mono>{policy.verdict}</Mono>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                    {policy.explanation}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle hint={`${run.memoriesUsed.length} retrieved`}>
            Memory used
          </CardTitle>
          {run.memoriesUsed.length === 0 ? (
            <p className="text-xs leading-relaxed text-ink-subtle">
              No stored memory passed the similarity threshold for this request.
            </p>
          ) : (
            <ul className="space-y-3">
              {run.memoriesUsed.map((memory) => (
                <li key={memory.id}>
                  <Link href={`/memory/${memory.id}`} className="group block">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-xs font-medium leading-snug text-ink group-hover:text-accent-ink">
                        {memory.summary}
                      </span>
                      <SimilarityMeter value={memory.similarity} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-muted">
                      {memory.content}
                    </p>
                    <p className="mt-1 text-[10px] text-ink-subtle">
                      {memory.memory_type.replace(/_/g, " ")} ·{" "}
                      {formatRelative(memory.occurred_at)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {run.toolsInvoked.length > 0 || run.actionsTaken.length > 0 ? (
        <Card>
          <CardTitle hint={`${run.toolsInvoked.length} calls`}>
            Tools and actions
          </CardTitle>
          <div className="grid gap-4 md:grid-cols-2">
            <ul className="space-y-1.5">
              {run.toolsInvoked.map((tool, index) => (
                <li
                  key={`${tool.tool}-${index}`}
                  className="flex items-baseline justify-between gap-3 text-xs"
                >
                  <span
                    className={cx(
                      "font-mono",
                      tool.is_error ? "text-reject" : "text-accent-ink",
                    )}
                  >
                    {tool.tool}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-muted">
                    {tool.result_summary}
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-ink-subtle">
                    {tool.duration_ms}ms
                  </span>
                </li>
              ))}
            </ul>

            {run.actionsTaken.length > 0 ? (
              <ul className="space-y-2">
                {run.actionsTaken.map((action, index) => (
                  <li key={`${action.action}-${index}`}>
                    <span className="font-mono text-[11px] text-approve">
                      {action.action}
                    </span>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                      {action.detail}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/** Cosine similarity, shown rather than hidden — retrieval quality is auditable. */
function SimilarityMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-raised">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: `${pct * 100}%` }}
        />
      </span>
      <span className="font-mono text-[10px] tabular-nums text-ink-subtle">
        {value.toFixed(3)}
      </span>
    </span>
  );
}

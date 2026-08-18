import type { PipelineStage } from "@/lib/agent/types";
import { cx } from "@/components/ui";

/**
 * The retrieval pipeline, rendered as a vertical trace.
 *
 * This is the visualization that makes the architecture legible: a request
 * enters, structured facts and semantic memories are pulled from CockroachDB,
 * capacity is checked, deterministic policy runs, and a decision falls out. Each
 * node reports a real count from the run it describes — nothing here is
 * decorative.
 */
export function PipelineTrace({ stages }: { stages: readonly PipelineStage[] }) {
  return (
    <ol className="relative space-y-0">
      {stages.map((stage, index) => {
        const isLast = index === stages.length - 1;
        const active = stage.status === "ok";

        return (
          <li key={stage.key} className="relative flex gap-3 pb-4 last:pb-0">
            {!isLast ? (
              <span
                className={cx(
                  "absolute left-[5px] top-3 h-full w-px",
                  active ? "bg-accent-dim" : "bg-line",
                )}
                aria-hidden
              />
            ) : null}

            <span
              className={cx(
                "relative z-10 mt-1.5 size-[11px] shrink-0 rounded-full border-2",
                active
                  ? "border-accent bg-canvas"
                  : "border-line-strong bg-canvas",
              )}
              aria-hidden
            />

            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span
                  className={cx(
                    "text-sm font-medium",
                    active ? "text-ink" : "text-ink-subtle",
                  )}
                >
                  {stage.label}
                </span>
                {stage.count !== null ? (
                  <span
                    className={cx(
                      "rounded px-1.5 py-px font-mono text-[11px] tabular-nums",
                      active
                        ? "bg-accent-dim text-accent-ink"
                        : "bg-surface-raised text-ink-subtle",
                    )}
                  >
                    {stage.count}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                {stage.detail}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

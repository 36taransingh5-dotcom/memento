import { Card } from "@/components/ui";

/**
 * Rendered whenever a page cannot reach CockroachDB.
 *
 * The application degrades to an explanation rather than a stack trace: the
 * fastest path from "the dashboard is blank" to "the database is not running"
 * is telling the operator exactly that, with the command that fixes it.
 */
export function ConnectionError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <Card className="border-reject-bg">
      <h2 className="text-sm font-semibold text-reject">
        Cannot reach CockroachDB
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
        Memento stores every structured fact and every semantic memory in
        CockroachDB, so there is nothing meaningful to show without it.
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-canvas p-3 font-mono text-xs leading-relaxed text-ink-subtle">
        {message}
      </pre>
      <div className="mt-4 space-y-1.5 text-xs text-ink-muted">
        <p>
          Local development:{" "}
          <code className="font-mono text-accent-ink">npm run db:up</code> then{" "}
          <code className="font-mono text-accent-ink">npm run db:setup</code>
        </p>
        <p>
          Deployed: check that <code className="font-mono">DATABASE_URL</code>{" "}
          points at a reachable cluster and that this host is allowed through the
          network policy.
        </p>
      </div>
    </Card>
  );
}

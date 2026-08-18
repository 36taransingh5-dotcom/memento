"use client";

import { useEffect } from "react";
import { Card, PageHeader } from "@/components/ui";

/**
 * Last-resort boundary. Pages catch their own database failures and render a
 * targeted explanation; this catches everything else without showing a blank
 * screen.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[memento] unhandled error:", error);
  }, [error]);

  return (
    <>
      <PageHeader title="Something went wrong" />
      <Card className="border-reject-bg">
        <p className="text-sm leading-relaxed text-ink-muted">
          This page failed to render. The error is in the server logs
          {error.digest ? ` under digest ${error.digest}` : ""}.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-canvas p-3 font-mono text-xs leading-relaxed text-ink-subtle">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
        >
          Try again
        </button>
      </Card>
    </>
  );
}

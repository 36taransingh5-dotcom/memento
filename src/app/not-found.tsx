import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";

export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <Card>
        <p className="text-sm leading-relaxed text-ink-muted">
          That record does not exist. It may have been removed by a database
          reset, or the link may be stale.
        </p>
        <Link
          href="/"
          className="mt-4 inline-block text-sm text-accent-ink hover:underline"
        >
          ← Back to the overview
        </Link>
      </Card>
    </>
  );
}

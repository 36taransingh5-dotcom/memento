import type { Metadata } from "next";
import { AgentConsole } from "@/components/AgentConsole";
import { ConnectionError } from "@/components/ConnectionError";
import { PageHeader } from "@/components/ui";
import { listUsers } from "@/lib/db/repositories/organization";

export const metadata: Metadata = { title: "Agent" };
export const dynamic = "force-dynamic";

export default async function AgentPage() {
  try {
    const users = await listUsers();

    return (
      <>
        <PageHeader
          title="Agent"
          description="Send an operational request. Memento retrieves organizational history, evaluates policy deterministically, decides, and shows you exactly what it looked at."
        />
        <AgentConsole users={users} />
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="Agent" />
        <ConnectionError error={error} />
      </>
    );
  }
}

import { BOLD, DIM, RESET, fail, heading, info, loadEnv, ok } from "./_env.ts";

loadEnv();

const { closePool } = await import("@/lib/db/client");
const { getUserByEmail } = await import("@/lib/db/repositories/organization");
const { runAgent } = await import("@/lib/agent/runtime");

/**
 * Runs the core demo scenario from the command line.
 *
 * Useful as a smoke test (`npm run demo`) and as the fastest way to see the
 * whole pipeline — structured recall, semantic recall, deterministic policy,
 * decision, memory write — without opening a browser.
 */

const SCENARIO = "I need another GPU for my computer vision experiment.";

async function main(): Promise<void> {
  const alex = await getUserByEmail("alex.chen@northstarlabs.io");
  if (!alex) {
    throw new Error("Northstar Labs is not seeded. Run `npm run db:seed` first.");
  }

  heading("Request");
  console.log(`  ${BOLD}${alex.name}${RESET} ${DIM}(${alex.team_name})${RESET}`);
  console.log(`  "${SCENARIO}"`);

  const result = await runAgent({
    userId: alex.id,
    message: SCENARIO,
    channel: "cli",
  });

  heading("Retrieval pipeline");
  for (const stage of result.pipeline) {
    const marker = stage.status === "ok" ? "●" : "○";
    const count = stage.count === null ? "" : ` ${DIM}[${stage.count}]${RESET}`;
    console.log(`  ${marker} ${stage.label}${count}`);
    console.log(`    ${DIM}${stage.detail}${RESET}`);
  }

  heading("Decision");
  console.log(`  ${BOLD}${result.decision}${RESET}  ${DIM}(confidence: ${result.confidence})${RESET}`);
  console.log(`\n  ${result.rationale}\n`);

  if (result.evidence.length > 0) {
    heading("Evidence");
    for (const item of result.evidence) {
      console.log(`  • ${item.label}`);
      console.log(`    ${DIM}${item.detail}${RESET}`);
    }
  }

  if (result.policiesTriggered.length > 0) {
    heading("Policies triggered");
    for (const policy of result.policiesTriggered) {
      const badge = policy.severity === "hard" ? "binding" : "advisory";
      console.log(`  • ${policy.name} ${DIM}(${badge})${RESET}`);
      console.log(`    ${DIM}${policy.explanation}${RESET}`);
    }
  }

  if (result.memoriesUsed.length > 0) {
    heading("Memory retrieved");
    for (const memory of result.memoriesUsed) {
      console.log(
        `  • ${memory.summary} ${DIM}(similarity ${memory.similarity.toFixed(3)})${RESET}`,
      );
    }
  }

  heading("Next action");
  console.log(`  ${result.nextAction}`);

  heading("Provenance");
  info(`Reasoning: ${result.reasoningProvider}${result.model ? ` (${result.model})` : ""}`);
  info(`Tools invoked: ${result.toolsInvoked.map((t) => t.tool).join(", ") || "none"}`);
  info(`Latency: ${result.latencyMs}ms`);
  if (result.policyOverrodeModel) {
    info(`Policy override: ${result.policyOverrideReason}`);
  }
  if (result.degradedReason) {
    info(`Degraded: ${result.degradedReason}`);
  }

  console.log("");
  ok(`Recorded as ${result.requestReference} — open http://localhost:3000/requests`);
}

main()
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());

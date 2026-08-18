import { fail, heading, info, loadEnv, ok, warn } from "./_env.ts";

loadEnv();

const { closePool, health } = await import("@/lib/db/client");
const { getMemoryStats } = await import("@/lib/db/repositories/memories");
const { backfillMissingEmbeddings } = await import("@/lib/memory/service");
const { embed } = await import("@/lib/ai/embeddings");

/**
 * Checks every dependency Memento needs and reports what is degraded.
 *
 * `npm run db:health -- --fix` re-embeds any memory that was written while the
 * embedding provider was unavailable.
 */

async function main(): Promise<void> {
  const shouldFix = process.argv.includes("--fix");

  heading("CockroachDB");
  const db = await health();
  if (!db.reachable) {
    fail(db.error ?? "unreachable");
    info("Run `npm run db:up` for a local cluster, or check DATABASE_URL.");
    process.exitCode = 1;
    return;
  }

  ok(`Connected to "${db.database}"`);
  info(db.version ?? "unknown version");

  if (db.vectorIndexPresent) {
    ok("C-SPANN vector index active — semantic search is index-accelerated");
  } else {
    warn(
      "Vector index absent. Semantic search falls back to an exact cosine scan, " +
        "which is correct but scans every row.",
    );
  }

  heading("Semantic memory");
  const stats = await getMemoryStats();
  ok(`${stats.total} memories, ${stats.embedded} embedded`);
  for (const row of stats.by_type) {
    info(`${row.count.toString().padStart(3)} ${row.memory_type}`);
  }

  const missing = stats.total - stats.embedded;
  if (missing > 0) {
    warn(`${missing} memories have no vector and cannot be retrieved semantically`);
    if (shouldFix) {
      const { repaired, failed } = await backfillMissingEmbeddings();
      ok(`Backfilled ${repaired} embeddings`);
      if (failed > 0) warn(`${failed} still failing`);
    } else {
      info("Run `npm run db:health -- --fix` to re-embed them.");
    }
  }

  heading("Amazon Bedrock");
  const probe = await embed("Memento health probe: GPU allocation for the ML team.");
  if (probe.provider === "bedrock") {
    ok(`Embeddings via ${probe.model} (${probe.vector.length} dimensions)`);
  } else {
    warn(
      `Embeddings falling back to ${probe.model}. Semantic retrieval matches shared ` +
        `vocabulary rather than meaning.`,
    );
    info("Configure AWS credentials and re-run `npm run db:seed` for true semantic memory.");
  }

  const bedrockConfigured = Boolean(
    process.env["AWS_ACCESS_KEY_ID"] ||
      process.env["AWS_PROFILE"] ||
      process.env["AWS_BEARER_TOKEN_BEDROCK"] ||
      process.env["AWS_ROLE_ARN"],
  );
  if (bedrockConfigured) {
    ok(`Reasoning model configured: ${process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-sonnet-5"}`);
  } else {
    warn(
      "No AWS credentials resolved — the agent will decide using the deterministic policy " +
        "engine alone, and will say so in the UI.",
    );
  }

  console.log("");
}

main()
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());

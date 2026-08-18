import pg from "pg";
import { fail, info, loadEnv, ok } from "./_env.ts";

loadEnv();

/** Blocks until CockroachDB accepts queries, so `db:setup` can chain reliably. */

const TIMEOUT_MS = 90_000;
const INTERVAL_MS = 1_000;

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set.");

  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = "";
  let announced = false;

  while (Date.now() < deadline) {
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 3_000,
      ssl: url.includes("sslmode=disable") ? undefined : { rejectUnauthorized: true },
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      ok("CockroachDB is accepting connections");
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await client.end().catch(() => {});
      if (!announced) {
        info("Waiting for CockroachDB to accept connections...");
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  }

  throw new Error(
    `CockroachDB did not become ready within ${TIMEOUT_MS / 1000}s. Last error: ${lastError}`,
  );
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

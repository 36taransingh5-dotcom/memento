import { spawnSync } from "node:child_process";
import pg from "pg";
import { fail, heading, info, loadEnv, ok } from "./_env.ts";

loadEnv();

/**
 * Drops every Memento table and rebuilds from scratch: migrate, then seed.
 *
 * The demo is supposed to be reproducible from a clean database, and this is
 * the command that proves it.
 */

const TABLES = [
  "audit_events",
  "agent_memories",
  "approvals",
  "agent_decisions",
  "agent_sessions",
  "request_events",
  "resource_allocations",
  "requests",
  "resources",
  "policies",
  "users",
  "teams",
  "schema_migrations",
];

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set.");

  heading("Resetting Memento");
  info(`Target: ${url.replace(/:\/\/[^@]*@/, "://***@")}`);

  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    ssl: url.includes("sslmode=disable") ? undefined : { rejectUnauthorized: true },
  });

  await client.connect();
  try {
    for (const table of TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    ok(`Dropped ${TABLES.length} tables`);
  } finally {
    await client.end();
  }

  run("npm", ["run", "db:migrate"]);
  run("npm", ["run", "db:seed"]);

  heading("Reset complete");
  ok("Run `npm run demo` to exercise the agent, or `npm run dev` for the dashboard.");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

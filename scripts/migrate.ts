import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { fail, heading, info, loadEnv, ok, warn } from "./_env.ts";

loadEnv();

/**
 * Migration runner.
 *
 * Two CockroachDB-specific behaviours drive the design:
 *
 *  - `SET CLUSTER SETTING` and some schema changes cannot run inside an explicit
 *    transaction, so each file is executed as a single simple query rather than
 *    wrapped in BEGIN/COMMIT. CockroachDB schema changes are online anyway.
 *  - Files named `*.optional.sql` are best-effort. They carry capabilities that
 *    may not be available on every cluster (the vector index needs a cluster
 *    setting a managed tier might not expose). A failure is recorded and warned
 *    about, never fatal — Memento's semantic search degrades from an indexed
 *    lookup to an exact scan rather than breaking.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

interface Migration {
  name: string;
  sql: string;
  optional: boolean;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"),
      optional: name.includes(".optional."),
    }));
}

/**
 * Ensure the target database exists.
 *
 * CockroachDB accepts a connection naming a database that does not exist — the
 * failure only surfaces on the first statement, as "no database or schema
 * specified". So we check `SHOW DATABASES` explicitly rather than treating a
 * successful connect as proof.
 *
 * On CockroachDB Cloud the database usually already exists and the connecting
 * role may not hold CREATEDB; that case gets a pointed error rather than a
 * permissions stack trace.
 */
async function ensureDatabase(url: string): Promise<void> {
  const databaseName = new URL(url).pathname.replace(/^\//, "") || "memento";
  const sslOption = url.includes("sslmode=disable")
    ? undefined
    : { rejectUnauthorized: true };

  const probe = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 8000,
    ssl: sslOption,
  });
  await probe.connect();
  let exists = false;
  try {
    const result = await probe.query(
      `SELECT 1 FROM [SHOW DATABASES] WHERE database_name = $1`,
      [databaseName],
    );
    exists = result.rows.length > 0;
  } finally {
    await probe.end().catch(() => {});
  }

  if (exists) return;

  info(`Database "${databaseName}" does not exist — creating it.`);
  const bootstrapUrl = new URL(url);
  bootstrapUrl.pathname = "/defaultdb";

  const bootstrap = new pg.Client({
    connectionString: bootstrapUrl.toString(),
    connectionTimeoutMillis: 8000,
    ssl: sslOption,
  });
  await bootstrap.connect();
  try {
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS "${databaseName}"`);
    ok(`Created database "${databaseName}"`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not create database "${databaseName}": ${detail}\n` +
        `If you are on CockroachDB Cloud, create it once in the Cloud Console ` +
        `(Databases -> Add database) and re-run this command.`,
    );
  } finally {
    await bootstrap.end();
  }
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");

  heading("Migrating CockroachDB");
  info(`Target: ${url.replace(/:\/\/[^@]*@/, "://***@")}`);

  await ensureDatabase(url);

  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    ssl: url.includes("sslmode=disable") ? undefined : { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        STRING PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        skipped     BOOL NOT NULL DEFAULT false,
        note        STRING NULL
      )
    `);

    const applied = new Set(
      (
        await client.query<{ name: string }>(
          "SELECT name FROM schema_migrations WHERE skipped = false",
        )
      ).rows.map((r) => r.name),
    );

    let ran = 0;
    let skipped = 0;

    for (const migration of loadMigrations()) {
      if (applied.has(migration.name)) {
        info(`${migration.name} — already applied`);
        continue;
      }

      try {
        await client.query(migration.sql);
        await client.query(
          `UPSERT INTO schema_migrations (name, skipped, note) VALUES ($1, false, NULL)`,
          [migration.name],
        );
        ok(migration.name);
        ran += 1;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);

        if (!migration.optional) {
          fail(`${migration.name} — ${detail}`);
          throw err;
        }

        await client.query(
          `UPSERT INTO schema_migrations (name, skipped, note) VALUES ($1, true, $2)`,
          [migration.name, detail],
        );
        warn(`${migration.name} — skipped (optional): ${detail}`);
        skipped += 1;
      }
    }

    const indexPresent = await client.query<{ count: number }>(
      `SELECT count(*)::INT AS count
         FROM [SHOW INDEXES FROM agent_memories]
        WHERE index_name = 'memories_embedding_cspann_idx'`,
    );

    heading("Result");
    ok(`${ran} migration${ran === 1 ? "" : "s"} applied, ${skipped} skipped`);

    if ((indexPresent.rows[0]?.count ?? 0) > 0) {
      ok("C-SPANN vector index active — semantic search is index-accelerated");
    } else {
      warn(
        "Vector index not present. Semantic search still works via exact cosine scan; " +
          "run `SET CLUSTER SETTING feature.vector_index.enabled = true;` and re-run to enable it.",
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

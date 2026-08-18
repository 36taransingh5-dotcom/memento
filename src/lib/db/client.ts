import pg from "pg";
import { env } from "@/lib/env";

/**
 * CockroachDB access layer.
 *
 * CockroachDB speaks the PostgreSQL wire protocol, so `pg` is the driver. Two
 * things differ from plain Postgres and are handled here:
 *
 *  1. SERIALIZABLE is the only isolation level. Contended transactions abort
 *     with SQLSTATE 40001 and the *client* is expected to retry them. See
 *     `transaction()`.
 *  2. Numerics come back as strings to avoid float64 precision loss. We parse
 *     DECIMAL into JS numbers explicitly, because every money/percentage value
 *     in this schema is far inside the safe-integer range.
 */

const { types } = pg;

// DECIMAL / NUMERIC -> number. Safe here: budgets and costs are small.
types.setTypeParser(1700, (value: string) => Number.parseFloat(value));
// INT8 -> number. Row counts and token counts, never beyond 2^53.
types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export type QueryParam =
  | string
  | number
  | boolean
  | null
  | Date
  | Buffer
  | readonly unknown[]
  | Record<string, unknown>;

/**
 * Next.js dev-mode hot reload re-evaluates modules; without this the pool would
 * leak a new set of connections on every edit.
 */
const globalForPool = globalThis as unknown as { __mementoPool?: pg.Pool };

export function pool(): pg.Pool {
  if (globalForPool.__mementoPool) return globalForPool.__mementoPool;

  const url = env().DATABASE_URL;
  const created = new pg.Pool({
    connectionString: url,
    max: env().DATABASE_POOL_MAX,
    // CockroachDB Cloud terminates idle connections; keep ours below that.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "memento",
    // `sslmode` in the URL drives TLS. Local docker runs insecure.
    ssl: url.includes("sslmode=disable") ? undefined : { rejectUnauthorized: true },
  });

  created.on("error", (err) => {
    // An idle client erroring out is recoverable — the pool evicts it. Log so
    // the failure is visible rather than silently degrading throughput.
    console.error("[db] idle client error:", err.message);
  });

  globalForPool.__mementoPool = created;
  return created;
}

export async function closePool(): Promise<void> {
  if (globalForPool.__mementoPool) {
    await globalForPool.__mementoPool.end();
    globalForPool.__mementoPool = undefined;
  }
}

export class DatabaseUnavailableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not reach CockroachDB: ${detail}\n` +
        `Check DATABASE_URL, and for local development run \`npm run db:up\`.`,
    );
    this.name = "DatabaseUnavailableError";
    this.cause = cause;
  }
}

function isConnectionFailure(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "57P01" || // admin_shutdown
    code === "08006" || // connection_failure
    code === "08001"
  );
}

/** CockroachDB retryable transaction error. */
function isRetryable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "40001";
}

/** Run a parameterized query. Never interpolate values into SQL by hand. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly QueryParam[] = [],
): Promise<T[]> {
  try {
    const result = await pool().query<T>(text, params as unknown[]);
    return result.rows;
  } catch (err) {
    if (isConnectionFailure(err)) throw new DatabaseUnavailableError(err);
    throw err;
  }
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly QueryParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export interface Tx {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParam[],
  ): Promise<T[]>;
  queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParam[],
  ): Promise<T | null>;
}

/**
 * Run `fn` inside a SERIALIZABLE transaction, retrying on CockroachDB's
 * retryable 40001 aborts with exponential backoff.
 *
 * `fn` must be side-effect free outside the database: it can be invoked more
 * than once.
 */
export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>,
  { maxAttempts = 5 }: { maxAttempts?: number } = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let client: pg.PoolClient;
    try {
      client = await pool().connect();
    } catch (err) {
      throw isConnectionFailure(err) ? new DatabaseUnavailableError(err) : err;
    }

    const tx: Tx = {
      async query(text, params = []) {
        const r = await client.query(text, params as unknown[]);
        return r.rows;
      },
      async queryOne(text, params = []) {
        const r = await client.query(text, params as unknown[]);
        return r.rows[0] ?? null;
      },
    };

    try {
      await client.query("BEGIN");
      const result = await fn(tx as Tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      lastError = err;
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already broken; the pool will discard it.
      }

      if (!isRetryable(err) || attempt === maxAttempts) {
        if (isConnectionFailure(err)) throw new DatabaseUnavailableError(err);
        throw err;
      }

      // Exponential backoff with jitter, per CockroachDB's retry guidance.
      const backoffMs = Math.min(2 ** attempt * 25, 500) + Math.random() * 25;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      client.release();
    }
  }

  throw lastError;
}

export interface DatabaseHealth {
  reachable: boolean;
  version: string | null;
  database: string | null;
  vectorIndexPresent: boolean;
  memoryCount: number;
  embeddedMemoryCount: number;
  error: string | null;
}

/** Used by the health script and the Overview page's infrastructure card. */
export async function health(): Promise<DatabaseHealth> {
  try {
    const meta = await queryOne<{ version: string; database: string }>(
      "SELECT version() AS version, current_database() AS database",
    );

    const idx = await queryOne<{ count: number }>(
      `SELECT count(*)::INT AS count
         FROM [SHOW INDEXES FROM agent_memories]
        WHERE index_name = 'memories_embedding_cspann_idx'`,
    );

    const memories = await queryOne<{ total: number; embedded: number }>(
      `SELECT count(*)::INT AS total,
              count(embedding)::INT AS embedded
         FROM agent_memories`,
    );

    return {
      reachable: true,
      version: meta?.version ?? null,
      database: meta?.database ?? null,
      vectorIndexPresent: (idx?.count ?? 0) > 0,
      memoryCount: memories?.total ?? 0,
      embeddedMemoryCount: memories?.embedded ?? 0,
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      version: null,
      database: null,
      vectorIndexPresent: false,
      memoryCount: 0,
      embeddedMemoryCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

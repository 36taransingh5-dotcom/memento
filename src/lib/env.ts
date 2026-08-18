import { z } from "zod";

/**
 * Validated server-side configuration.
 *
 * Every value here is server-only. Nothing in this module may be imported from
 * a client component — secrets must never cross the network boundary.
 */

const schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required — see .env.example")
    .refine(
      (v) => v.startsWith("postgresql://") || v.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL-wire connection string (CockroachDB speaks the pg wire protocol)",
    ),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  AWS_REGION: z.string().min(1).default("us-east-1"),
  BEDROCK_MODEL_ID: z.string().min(1).default("anthropic.claude-sonnet-5"),
  BEDROCK_EFFORT: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .default("medium"),
  BEDROCK_EMBEDDING_MODEL_ID: z
    .string()
    .min(1)
    .default("amazon.titan-embed-text-v2:0"),

  /**
   * Must match the `VECTOR(n)` width in db/migrations/001_init.sql. Changing
   * one without the other produces a runtime insert error, so we check it at
   * startup instead (see assertEmbeddingDimensions).
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),

  ALLOW_DEGRADED_AI: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * In development a fresh clone should run against `docker compose up -d` with
 * no configuration at all. In production an unset DATABASE_URL is a deployment
 * error, not something to paper over with a localhost default — so the fallback
 * is gated on NODE_ENV.
 */
const LOCAL_DATABASE_URL =
  "postgresql://root@localhost:26257/memento?sslmode=disable";

export function env(): Env {
  if (cached) return cached;

  if (!process.env["DATABASE_URL"] && process.env.NODE_ENV !== "production") {
    process.env["DATABASE_URL"] = LOCAL_DATABASE_URL;
  }

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${detail}\n\n` +
        `Copy .env.example to .env.local and fill in the required values.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** The vector width the schema was migrated with. */
export const SCHEMA_EMBEDDING_DIMENSIONS = 1024;

export function assertEmbeddingDimensions(): void {
  const configured = env().EMBEDDING_DIMENSIONS;
  if (configured !== SCHEMA_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `EMBEDDING_DIMENSIONS is ${configured} but agent_memories.embedding is ` +
        `VECTOR(${SCHEMA_EMBEDDING_DIMENSIONS}). Either set EMBEDDING_DIMENSIONS=` +
        `${SCHEMA_EMBEDDING_DIMENSIONS}, or change the column width in ` +
        `db/migrations/001_init.sql and re-run \`npm run db:reset\`.`,
    );
  }
}

/** True when AWS credentials are resolvable from the environment. */
export function hasExplicitAwsCredentials(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_ROLE_ARN,
  );
}

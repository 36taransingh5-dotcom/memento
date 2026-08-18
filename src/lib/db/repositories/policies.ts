import { query, queryOne } from "@/lib/db/client";
import type { Policy, PolicyCategory } from "@/lib/db/types";

/**
 * Policies live in the database, not in the prompt. The LLM is never asked to
 * remember or reproduce an organizational rule — it is only ever shown the
 * verdicts the deterministic engine already computed.
 */

export async function listPolicies(
  filter: { enabledOnly?: boolean; category?: PolicyCategory } = {},
): Promise<Policy[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.enabledOnly !== false) clauses.push("enabled = true");
  if (filter.category) {
    params.push(filter.category);
    clauses.push(`category = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return query<Policy>(
    `SELECT * FROM policies ${where}
      ORDER BY severity DESC, category, key`,
    params as never,
  );
}

export async function getPolicyByKey(key: string): Promise<Policy | null> {
  return queryOne<Policy>(`SELECT * FROM policies WHERE key = $1`, [key]);
}

export async function setPolicyEnabled(
  key: string,
  enabled: boolean,
): Promise<Policy | null> {
  return queryOne<Policy>(
    `UPDATE policies SET enabled = $2, updated_at = now() WHERE key = $1 RETURNING *`,
    [key, enabled],
  );
}

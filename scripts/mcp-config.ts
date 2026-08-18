import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail, heading, info, loadEnv, ok, warn } from "./_env.ts";

loadEnv();

/**
 * Writes `.mcp.json` so an MCP-capable client (Claude Code, Cursor) can talk to
 * the CockroachDB Cloud Managed MCP Server for this cluster.
 *
 * This is developer and operator tooling, not part of the agent's decision
 * loop — see docs/mcp.md for why that separation is deliberate. The generated
 * file is gitignored: while a cluster ID alone isn't a bearer credential,
 * treating it as project-local config avoids hardcoding a specific cluster
 * into a public repo. Auth itself is handled by CockroachDB Cloud via OAuth
 * on first connect, not a static API key — there is nothing else to inject.
 */

function main(): void {
  const clusterId = process.env["CRDB_MCP_CLUSTER_ID"];

  heading("CockroachDB Managed MCP Server");

  if (!clusterId) {
    warn("CRDB_MCP_CLUSTER_ID is not set.");
    info(
      "Run `claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp \\\n" +
        '  --transport http --header "mcp-cluster-id: <your-cluster-id>"` — CockroachDB Cloud\n' +
        "  Console shows this exact command under your cluster's Connect panel. Copy the\n" +
        "  cluster ID into .env.local as CRDB_MCP_CLUSTER_ID, then re-run `npm run mcp:config`.\n" +
        "  See docs/mcp.md.",
    );
    process.exitCode = 1;
    return;
  }

  const config = {
    mcpServers: {
      "cockroachdb-cloud": {
        type: "http",
        url: "https://cockroachlabs.cloud/mcp",
        headers: { "mcp-cluster-id": clusterId },
      },
    },
  };

  const path = resolve(process.cwd(), ".mcp.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  ok(`Wrote ${path}`);
  info(
    "Restart your MCP client to pick up the new server. First use will prompt an OAuth " +
      "login in the browser — this can't be completed in a non-interactive session.",
  );
  info('Try: "Show me the schema of agent_memories and how many memories each team has."');
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

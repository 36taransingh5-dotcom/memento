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
 * file is gitignored because it carries a cluster credential.
 */

function main(): void {
  const url = process.env["CRDB_MCP_URL"];
  const apiKey = process.env["CRDB_MCP_API_KEY"];

  heading("CockroachDB Managed MCP Server");

  if (!url) {
    warn("CRDB_MCP_URL is not set.");
    info(
      "In the CockroachDB Cloud Console open your cluster, go to the MCP Server tab, and copy the\n" +
        "  endpoint and API key into .env.local as CRDB_MCP_URL and CRDB_MCP_API_KEY. Then re-run\n" +
        "  `npm run mcp:config`. See docs/mcp.md.",
    );
    process.exitCode = 1;
    return;
  }

  const config = {
    mcpServers: {
      cockroachdb: {
        type: "http",
        url,
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      },
    },
  };

  const path = resolve(process.cwd(), ".mcp.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  ok(`Wrote ${path}`);
  if (!apiKey) {
    warn("CRDB_MCP_API_KEY is not set — the server entry has no Authorization header.");
  }
  info("Restart your MCP client to pick up the new server.");
  info('Try: "Show me the schema of agent_memories and how many memories each team has."');
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

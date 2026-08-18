# CockroachDB Managed MCP Server

Memento uses the [CockroachDB Managed MCP Server](https://www.cockroachlabs.com/docs/v26.2/cockroachdb-mcp-server) as **developer and operator tooling** — a way to inspect and query the live cluster from an MCP-capable AI assistant (Claude Code, Cursor) while working on this repo. It is deliberately **not** wired into the agent's own reasoning loop.

## Why not in the agent loop

The agent's tools (`src/lib/agent/tools.ts`) go through the app's typed repository layer, which enforces the same invariants the UI does — a resource can't be allocated without an allocation row, a decision can't be recorded without policy having run first. A raw-SQL MCP tool inside the agent's tool-calling loop would let the model construct arbitrary queries that bypass those invariants entirely. The MCP server's value here is squarely on the human side of the system: an engineer debugging why a decision came out a certain way, inspecting schema, or checking cluster health without leaving their editor.

## Setup

1. In **CockroachDB Cloud Console**, open your cluster → **Connect**. It shows a ready-to-run command:
   ```bash
   claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp \
     --transport http --header "mcp-cluster-id: <your-cluster-id>"
   ```
   Auth is handled by CockroachDB Cloud via OAuth on first connect — there's no separate API key to manage or rotate.
2. Add the cluster ID to `.env.local`:
   ```bash
   CRDB_MCP_CLUSTER_ID=<your-cluster-id>
   ```
3. Generate the MCP client config:
   ```bash
   npm run mcp:config
   ```
   This writes `.mcp.json` (gitignored — kept project-local rather than hardcoding a cluster into a public repo) in the shape Claude Code and other MCP clients expect:
   ```json
   {
     "mcpServers": {
       "cockroachdb-cloud": {
         "type": "http",
         "url": "https://cockroachlabs.cloud/mcp",
         "headers": { "mcp-cluster-id": "<CRDB_MCP_CLUSTER_ID>" }
       }
     }
   }
   ```
4. Restart your MCP client to pick up the new server. The first tool call triggers a browser OAuth prompt — this step can't be automated in a non-interactive session, so it has to happen once, interactively, per machine.

## What it's good for

The managed server exposes read-only tools by default (schema inspection, `EXPLAIN`, read-only SQL) with write access available as an explicit opt-in from the Cloud Console. Useful prompts once connected:

- *"Show me the schema of `agent_memories` and confirm the vector index is active."*
- *"How many memories does each team have, and how many carry an embedding?"*
- *"Explain the query plan for the nearest-neighbour search in `searchMemories`."*
- *"Which resources are idle right now, and what's their total monthly cost?"*

## Security

Read-only mode is the default; only opt into write access if you specifically need the assistant to create test data. `.mcp.json` doesn't carry a bearer credential — access is gated by an OAuth session tied to your CockroachDB Cloud account — but it's still kept out of the repo (`.gitignore`) since it names a specific cluster.

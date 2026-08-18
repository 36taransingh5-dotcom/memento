# CockroachDB Managed MCP Server

Memento uses the [CockroachDB Managed MCP Server](https://www.cockroachlabs.com/docs/v26.2/cockroachdb-mcp-server) as **developer and operator tooling** — a way to inspect and query the live cluster from an MCP-capable AI assistant (Claude Code, Cursor) while working on this repo. It is deliberately **not** wired into the agent's own reasoning loop.

## Why not in the agent loop

The agent's tools (`src/lib/agent/tools.ts`) go through the app's typed repository layer, which enforces the same invariants the UI does — a resource can't be allocated without an allocation row, a decision can't be recorded without policy having run first. A raw-SQL MCP tool inside the agent's tool-calling loop would let the model construct arbitrary queries that bypass those invariants entirely. The MCP server's value here is squarely on the human side of the system: an engineer debugging why a decision came out a certain way, inspecting schema, or checking cluster health without leaving their editor.

## Setup

1. In **CockroachDB Cloud Console**, open your cluster → **MCP Server** tab.
2. Copy the generated endpoint URL and API key.
3. Add them to `.env.local`:
   ```bash
   CRDB_MCP_URL=<endpoint from the console>
   CRDB_MCP_API_KEY=<api key from the console>
   ```
4. Generate the MCP client config:
   ```bash
   npm run mcp:config
   ```
   This writes `.mcp.json` (gitignored — it carries a credential) in the shape Claude Code and other MCP clients expect:
   ```json
   {
     "mcpServers": {
       "cockroachdb": {
         "type": "http",
         "url": "<CRDB_MCP_URL>",
         "headers": { "Authorization": "Bearer <CRDB_MCP_API_KEY>" }
       }
     }
   }
   ```
5. Restart your MCP client to pick up the new server.

## What it's good for

The managed server exposes read-only tools by default (schema inspection, `EXPLAIN`, read-only SQL) with write access available as an explicit opt-in from the Cloud Console. Useful prompts once connected:

- *"Show me the schema of `agent_memories` and confirm the vector index is active."*
- *"How many memories does each team have, and how many carry an embedding?"*
- *"Explain the query plan for the nearest-neighbour search in `searchMemories`."*
- *"Which resources are idle right now, and what's their total monthly cost?"*

## Security

Read-only mode is the default; only opt into write access if you specifically need the assistant to create test data. The API key in `.mcp.json` is cluster-scoped — treat it like any other database credential and never commit it (the file is in `.gitignore` for this reason).

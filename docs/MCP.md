# MCP (Phase 6)

The Worker serves a remote MCP server at `/mcp`. It exposes the same 11 tools that `/chat` gives the LLM and that `/api` serves to the UI, through the same functions in `src/tools/`. The protocol layer is `src/mcp/server.ts`, about 200 lines with no SDK.

## Connect a client

Each account uses its own **personal API token**: in the app, open the user menu → **API token (MCP)** → Create token, and copy it (it's shown once). The token only reaches that account's data. Replace `<url>` with your deployed URL and `<token>` with yours.

**Claude Code**
```bash
claude mcp add --transport http expense-agent <url>/mcp --header "Authorization: Bearer <token>"
```

**Claude Desktop** (Settings → Developer → Edit config), through the `mcp-remote` bridge so a header can be sent:
```json
{
  "mcpServers": {
    "expense-agent": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<url>/mcp", "--header", "Authorization: Bearer ${EXPENSE_AGENT_TOKEN}"],
      "env": { "EXPENSE_AGENT_TOKEN": "<token>" }
    }
  }
}
```

**Script client** (the official TypeScript SDK; client #2 from the plan):
```bash
node scripts/mcp-client.mjs <url>/mcp add "coffee" 45 food_dining
```
Set the `EXPENSE_AGENT_TOKEN` environment variable to your token first. With no URL it talks to `http://localhost:8787/mcp` (`npm run dev`).

**MCP Inspector**, for poking at it by hand:
```bash
npx @modelcontextprotocol/inspector
```
Choose "Streamable HTTP", enter the URL, and add the Authorization header.


## What the server does

- **Transport:** Streamable HTTP, stateless. Each `POST /mcp` carries one JSON-RPC message and gets one `application/json` reply. Notifications get `202`. `GET` and `DELETE` get `405`, because there is no server-to-client stream and no session. That is enough for a tools-only server, and it fits a Worker with no Durable Objects.
- **Versions:** `2025-11-25`, `2025-06-18`, `2025-03-26`. The server echoes the client's version when it supports it, and rejects an unsupported `MCP-Protocol-Version` header with `400`.
- **Tools:** each has a title, a JSON Schema generated from the same zod schema the tool validates with, and annotations (`readOnlyHint` for the six report tools, `destructiveHint` for delete and undo).
- **Results:** a text summary (the code-built status line, e.g. "Added coffee 45. Food & Dining: 45 spent this month") plus `structuredContent` with the full object. Validation and domain errors come back as `isError: true` results the calling model can read and fix; an unknown tool is a JSON-RPC error.
- **Confirmation:** in `/chat`, large or old expenses wait for the UI's Confirm button (D11). MCP clients show the user every tool call before it runs, so `add_expense` takes `confirmed: true` on a second call, after the user agrees.
- **Logging:** every call goes to the `logs` table with path `mcp`. Rows written this way have `source = 'mcp'`.

## Direct function calling vs MCP: what MCP abstracts and what it costs

| | Direct function calling (`/chat`) | MCP (`/mcp`) |
|---|---|---|
| Who runs the loop | This Worker: it sends the prompt and tool schemas to Groq, runs the calls the model picks, and loops (`src/chat/loop.ts`). | The client app (Claude Desktop, Claude Code, an agent). The server only answers `tools/list` and `tools/call`. |
| Which model | Whichever one is in `wrangler.jsonc`, paid for (or free-tier-limited) by you. | Whatever the client uses. No LLM key or quota is spent on the server. |
| Tool schemas | Hand-sent on every request in the provider's format (OpenAI-style `tools`). | Discovered once via `tools/list` in a standard format, so any MCP client can use them without code for this app. |
| Prompting | A system prompt in this repo carries the dates, category hints and rules. | Only `instructions` and tool descriptions. The client's own system prompt decides the rest, so the dates and hints have to live in tool descriptions or come back in results. |
| UI | This app's chat, Confirm button, status lines and tables. | The client's UI: tool-call approval and generic rendering of text/JSON results. |
| Safety | The model can never confirm a large expense, and the fast path and validation run before anything is written. | The same validation, plus the user approves each call in the client. Confirmation becomes a flag the model sets after asking. |
| Cost per message | 1–6 LLM calls of several thousand tokens on the server's quota, or none on the fast path. | Zero LLM tokens on the server; one HTTP round trip per tool call. |
| What it abstracts | Nothing: you own the loop, retries, timeouts, the iteration cap and the fallback model. | Transport, discovery, schema format and the agent loop. Write the tools once and every MCP client can use them. |
| What it costs | Code you maintain and model quota you spend. | Less control over prompting and UX, a protocol to keep current (three spec versions in two years), and auth that every client handles differently. |

**Takeaway:** for this app the two complement each other. `/chat` is the fast, tuned, phone-friendly path with your own UI and the regex fast path. `/mcp` lets any assistant you already use read and write the same data, without another key or another prompt to maintain. One tool layer serves both, plus the UI, which is what made adding MCP a 200-line job.

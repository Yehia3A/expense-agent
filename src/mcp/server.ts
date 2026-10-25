import { z } from "zod";
import { appConfig, type Env } from "../env";
import { ulid } from "../lib/ulid";
import { addExpenses, ItemInput } from "../tools/expenses";
import { callTool, TOOLS } from "../tools/registry";
import { defineTool, type Tool, type ToolContext } from "../tools/types";

// Remote MCP server (Phase 6, plan 6): the same tool layer as /chat and /api,
// spoken over MCP's Streamable HTTP transport in stateless mode. Every POST
// carries one JSON-RPC message and gets one JSON response; there is no
// session and no server-to-client stream, which is all a tools-only server
// needs and fits a Worker. Written by hand (no SDK) so the protocol stays
// visible: docs/MCP.md compares it with direct function calling.

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "expense-agent", title: "ExpenseAgent", version: "0.5.0" };

// Over MCP the client application (Claude Desktop, Claude Code, ...) shows the
// user every tool call before it runs, so a large or old expense can be
// confirmed in the same call. In /chat the model never gets this flag (D11).
const mcpAddExpense = defineTool({
  name: "add_expense",
  description:
    "Record one or more expenses the user spent. Put every item from one message into a single call. " +
    "Amounts above the large-amount threshold or dates more than 60 days back return needs_confirmation and save nothing; " +
    "after the user explicitly confirms, call again with confirmed: true.",
  input: z.object({
    items: z.array(ItemInput).min(1).max(30),
    confirmed: z.boolean().default(false).describe("Only true after the user explicitly confirmed the needs_confirmation items."),
  }),
  async run(ctx, input) {
    return addExpenses(ctx, input.items, input.confirmed);
  },
});

const READ_ONLY = new Set(["list_expenses", "summarize", "budget_status", "monthly_report", "top_spending", "monthly_history", "list_categories"]);
const DESTRUCTIVE = new Set(["delete_expense", "undo_request"]);
const TITLES: Record<string, string> = {
  add_expense: "Add expenses",
  list_expenses: "List expenses",
  update_expense: "Edit an expense",
  delete_expense: "Delete an expense",
  undo_request: "Undo a message",
  summarize: "Summarize spending",
  budget_status: "Budget status",
  set_budget: "Set a budget",
  monthly_report: "Monthly report",
  top_spending: "Top spending",
  monthly_history: "Monthly history",
  list_categories: "Your categories",
};

const MCP_TOOLS: Tool[] = TOOLS.map((t) => (t.name === "add_expense" ? (mcpAddExpense as Tool) : t));
const mcpByName = new Map(MCP_TOOLS.map((t) => [t.name, t]));

let listCache: unknown[] | null = null;
function toolList() {
  return (listCache ??= MCP_TOOLS.map((t) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    return {
      name: t.name,
      title: TITLES[t.name] ?? t.name,
      description: t.description,
      inputSchema,
      annotations: {
        readOnlyHint: READ_ONLY.has(t.name),
        destructiveHint: DESTRUCTIVE.has(t.name),
        idempotentHint: READ_ONLY.has(t.name),
        openWorldHint: false,
      },
    };
  }));
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const rpcHeaders = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const result = (id: JsonRpcId, res: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: res }), { headers: rpcHeaders });
const rpcError = (id: JsonRpcId, code: number, message: string, status = 200, data?: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }), { status, headers: rpcHeaders });

export interface McpDeps {
  now?: () => Date;
  /** The account the caller's personal API token (or session) belongs to. */
  userId: string;
  timezone?: string;
}

export async function handleMcp(req: Request, env: Env, deps: McpDeps): Promise<Response> {
  // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { ...rpcHeaders, allow: "POST" } });
  }
  const version = req.headers.get("mcp-protocol-version");
  if (version && !SUPPORTED_VERSIONS.includes(version)) {
    return rpcError(null, -32600, `unsupported MCP-Protocol-Version ${version}; supported: ${SUPPORTED_VERSIONS.join(", ")}`, 400);
  }

  let msg: JsonRpcRequest;
  try {
    msg = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "batches are not supported", 400);
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(null, -32600, "invalid request", 400);

  // Notifications (no id) and responses from the client get 202 and no body.
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const id = msg.id;

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return result(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Personal expense tracker (amounts in the account currency unless a currency is given; dates in the account's time zone). Record spending with add_expense, never invent amounts, " +
          "and answer spending questions with the read-only tools, quoting their numbers exactly.",
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: toolList() });
    case "tools/call":
      return callMcpTool(env, id, msg.params ?? {}, deps);
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

async function callMcpTool(env: Env, id: JsonRpcId, params: Record<string, unknown>, deps: McpDeps): Promise<Response> {
  const name = String(params.name ?? "");
  if (!mcpByName.has(name)) return rpcError(id, -32602, `unknown tool: ${name}`);
  const started = Date.now();
  const ctx: ToolContext = {
    db: env.DB,
    userId: deps.userId,
    now: deps.now ?? (() => new Date()),
    config: appConfig(env, deps.timezone),
    requestId: ulid(),
    source: "mcp",
    lineCounter: { next: 0 },
  };
  const args = params.arguments ?? {};
  const tool = mcpByName.get(name)!;
  // add_expense has its MCP variant; everything else is the shared tool, validated by callTool.
  const outcome =
    tool === (mcpAddExpense as Tool)
      ? await (async () => {
          const parsed = mcpAddExpense.input.safeParse(args);
          if (!parsed.success) return { ok: false as const, error: "invalid arguments", details: z.treeifyError(parsed.error) };
          return { ok: true as const, result: await mcpAddExpense.run(ctx, parsed.data) };
        })()
      : await callTool(ctx, name, args);

  await env.DB.prepare(
    `INSERT INTO logs (id, user_id, request_id, ts, user_text, path, tool_calls, results, latency_ms, error)
     VALUES (?, ?, ?, ?, NULL, 'mcp', ?, ?, ?, ?)`,
  )
    .bind(ulid(), ctx.userId, ctx.requestId, new Date().toISOString(), JSON.stringify([{ name, args, ok: outcome.ok }]), JSON.stringify(outcome), Date.now() - started, outcome.ok ? null : outcome.error)
    .run();

  // Tool failures are results with isError, so the calling model can read and fix them.
  if (!outcome.ok) {
    const text = JSON.stringify({ error: outcome.error, details: outcome.details });
    return result(id, { content: [{ type: "text", text }], isError: true });
  }
  const r = outcome.result as { status?: string; status_lines?: string[]; errors?: string[] };
  const summary = r.status_lines?.length ? r.status_lines.join("\n") + "\n\n" : "";
  return result(id, {
    content: [{ type: "text", text: summary + JSON.stringify(outcome.result) }],
    structuredContent: outcome.result,
    isError: r.status === "error",
  });
}

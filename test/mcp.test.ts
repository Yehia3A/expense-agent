import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import type { ExpenseRow } from "../src/tools/types";
import { NOW, resetDb } from "./helpers";

beforeEach(resetDb);

let nextId = 1;
async function rpc(method: string, params?: unknown, opts: { headers?: Record<string, string>; e?: typeof env; id?: number | null } = {}) {
  const body = opts.id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: opts.id ?? nextId++, method, params };
  const res = await handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...opts.headers },
      body: JSON.stringify(body),
    }),
    opts.e ?? env,
    { now: () => NOW },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const call = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).body.result;
const rows = async () => (await env.DB.prepare("SELECT * FROM expenses WHERE deleted_at IS NULL").all<ExpenseRow>()).results;

describe("MCP lifecycle (Streamable HTTP, stateless)", () => {
  it("initialize negotiates the protocol version and declares tools", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "expense-agent" },
    });
    const unknown = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(unknown.body.result.protocolVersion).toBe("2025-11-25");
  });

  it("notifications get 202 with no body", async () => {
    const r = await rpc("notifications/initialized", undefined, { id: null });
    expect(r).toEqual({ status: 202, body: null });
  });

  it("ping, unknown methods, bad JSON, batches, unsupported version header, GET", async () => {
    expect((await rpc("ping")).body.result).toEqual({});
    expect((await rpc("resources/list")).body.error.code).toBe(-32601);
    const bad = await handle(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" }), env);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const batch = await handle(
      new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]) }),
      env,
    );
    expect(batch.status).toBe(400);
    expect((await rpc("ping", undefined, { headers: { "mcp-protocol-version": "2020-01-01" } })).status).toBe(400);
    expect((await rpc("ping", undefined, { headers: { "mcp-protocol-version": "2025-06-18" } })).status).toBe(200);
    expect((await handle(new Request("http://localhost/mcp"), env)).status).toBe(405);
  });
});

describe("MCP tools (one tool layer, plan 6)", () => {
  it("lists all 12 tools with JSON Schemas and annotations", async () => {
    const tools = (await rpc("tools/list")).body.result.tools as { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[];
    expect(tools).toHaveLength(12);
    expect(tools.find((t) => t.name === "list_categories")!.annotations.readOnlyHint).toBe(true);
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    expect(tools.find((t) => t.name === "budget_status")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "add_expense")!.annotations.readOnlyHint).toBe(false);
  });

  it("add_expense writes rows with source 'mcp' and returns status lines + structured content", async () => {
    const r = await call("add_expense", { items: [{ amount: 200, category: "food_dining", note: "coffee" }] });
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain("Added coffee 200. Food & Dining");
    expect(r.structuredContent.status).toBe("saved");
    const saved = await rows();
    expect(saved.map((s) => [s.note, s.source, s.expense_date])).toEqual([["coffee", "mcp", "2026-10-19"]]);
  });

  it("large amounts need an explicit confirmed: true", async () => {
    const first = await call("add_expense", { items: [{ amount: 9000, category: "shopping", note: "tv" }] });
    expect(first.structuredContent.status).toBe("needs_confirmation");
    expect(await rows()).toHaveLength(0);
    const second = await call("add_expense", { items: [{ amount: 9000, category: "shopping", note: "tv" }], confirmed: true });
    expect(second.structuredContent.status).toBe("saved");
    expect(await rows()).toHaveLength(1);
  });

  it("read-only tools answer from the same data", async () => {
    await call("add_expense", { items: [{ amount: 300, category: "groceries", note: "vegs" }] });
    const status = await call("budget_status", { month: "2026-10" });
    expect(status.structuredContent.rows.find((r: { category: string }) => r.category === "groceries").spent).toBe(300);
    const top = await call("top_spending", { start_date: "2026-10-01", end_date: "2026-10-19", by: "item" });
    expect(top.structuredContent.ranked[0].key).toBe("vegs");
  });

  it("bad arguments come back as isError results the model can read; unknown tools are protocol errors", async () => {
    const r = await call("add_expense", { items: [{ amount: -1, category: "pets", note: "x" }] });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("invalid arguments");
    const u = await rpc("tools/call", { name: "drop_tables", arguments: {} });
    expect(u.body.error.code).toBe(-32602);
    expect(await rows()).toHaveLength(0);
  });

  it("every call is logged with path 'mcp'", async () => {
    await call("budget_status", {});
    const log = await env.DB.prepare("SELECT path, tool_calls FROM logs WHERE path = 'mcp'").first<{ path: string; tool_calls: string }>();
    expect(JSON.parse(log!.tool_calls)[0].name).toBe("budget_status");
  });
});

describe("MCP auth", () => {
  it("needs a personal API token (or a session) once accounts exist", async () => {
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('u1', 'someone', 'x', 'now', 'now')").run();
    expect((await rpc("ping")).status).toBe(401);
    expect((await rpc("ping", undefined, { headers: { authorization: "Bearer ea_not_a_real_token_at_all_xxxxxxxxxx" } })).status).toBe(401);
  });
});

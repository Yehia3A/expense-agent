import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runChat } from "../src/chat/loop";
import { handle } from "../src/index";
import type { ExpenseRow } from "../src/tools/types";
import { NOW, resetDb } from "./helpers";

// D34: with open sign-up, one account must never see or change another's data.
beforeEach(resetDb);

const HOST = "https://app.example.workers.dev";
let ip = 0;
function req(path: string, cookie: string, init: { method?: string; body?: unknown; bearer?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": `10.0.0.${++ip % 250}` };
  if (cookie) headers.cookie = cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return handle(
    new Request(`${HOST}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    { now: () => NOW },
  );
}
async function account(username: string) {
  const res = await req("/api/auth/signup", "", { body: { username, password: "long enough password" } });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const id = (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: string }>())!.id;
  // A new account picks its categories first (D41).
  const setup = await req("/api/categories", cookie, { method: "PUT", body: { categories: [{ name: "Food & Dining" }, { name: "Shopping" }] } });
  expect(setup.status).toBe(200);
  return { cookie, id };
}
const add = (cookie: string, requestId: string, note: string, amount: number) =>
  req("/api/expenses", cookie, { body: { request_id: requestId, items: [{ amount, category: "food_dining", note }] } });

describe("cross-account isolation", () => {
  it("lists, reports and budgets only ever show your own data", async () => {
    const a = await account("alice");
    const b = await account("bob");
    await add(a.cookie, "alice-req-01", "alice coffee", 120);
    await req("/api/budgets", a.cookie, { method: "PUT", body: { category: "food_dining", amount: 999 } });

    const bobRecent = (await (await req("/api/expenses/recent", b.cookie)).json()) as ExpenseRow[];
    expect(bobRecent).toEqual([]);
    const bobStatus = (await (await req("/api/budget-status?month=2026-10", b.cookie)).json()) as {
      total: { spent: number };
      rows: { category: string; budget: number | null }[];
    };
    expect(bobStatus.total.spent).toBe(0);
    expect(bobStatus.rows.find((r) => r.category === "food_dining")!.budget).toBeNull();
    const bobReport = (await (await req("/api/report?month=2026-10", b.cookie)).json()) as { total: number; top_expenses: unknown[] };
    expect(bobReport).toMatchObject({ total: 0, top_expenses: [] });
    const bobHistory = (await (await req("/api/history", b.cookie)).json()) as { months_with_data: string[] };
    expect(bobHistory.months_with_data).toEqual([]);

    const aliceRecent = (await (await req("/api/expenses/recent", a.cookie)).json()) as ExpenseRow[];
    expect(aliceRecent.map((r) => r.note)).toEqual(["alice coffee"]);
  });

  it("you can't edit, delete or undo someone else's expense, even knowing its id or request id", async () => {
    const a = await account("alice");
    const b = await account("bob");
    const saved = ((await (await add(a.cookie, "alice-req-02", "alice lunch", 200)).json()) as { saved: ExpenseRow[] }).saved;
    const id = saved[0]!.id;

    expect((await req(`/api/expenses/${id}`, b.cookie, { method: "PATCH", body: { fields: { amount: 1 } } })).status).toBe(400);
    expect((await req(`/api/expenses/${id}`, b.cookie, { method: "DELETE" })).status).toBe(400);
    expect((await req("/api/undo", b.cookie, { body: { request_id: "alice-req-02" } })).status).toBe(400);

    const still = (await (await req("/api/expenses/recent", a.cookie)).json()) as ExpenseRow[];
    expect(still.map((r) => [r.note, r.amount])).toEqual([["alice lunch", 200]]);
  });

  it("reusing someone else's request id writes your own row and never returns theirs", async () => {
    const a = await account("alice");
    const b = await account("bob");
    await add(a.cookie, "shared-req-1", "alice secret", 300);
    const res = (await (await add(b.cookie, "shared-req-1", "bob snack", 40)).json()) as { saved: ExpenseRow[] };
    expect(res.saved.map((r) => [r.note, r.user_id])).toEqual([["bob snack", b.id]]);
  });

  it("chat replay by request id stays inside your account", async () => {
    const a = await account("alice");
    const b = await account("bob");
    await env.DB.prepare("INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', 'coffee', 'food_dining', 1, 'x')").run();
    const first = await runChat(env, a.id, { message: "coffee 55", request_id: "chat-req-777", history: [] }, { now: () => NOW });
    expect(first.saved).toHaveLength(1);
    const noLlm = (async () => Response.json({ choices: [{ message: { content: "hi bob" } }] })) as unknown as typeof fetch;
    const bob = await runChat(env, b.id, { message: "hello", request_id: "chat-req-777", history: [] }, { now: () => NOW, fetchImpl: noLlm });
    expect(bob.replayed).toBeUndefined();
    expect(bob.saved).toEqual([]);
    expect(bob.reply).toBe("hi bob");
  });

  it("learned merchant words are per account", async () => {
    const a = await account("alice");
    const b = await account("bob");
    // Alice teaches "koshary place" -> food_dining by correcting a row.
    const saved = ((await (await req("/api/expenses", a.cookie, {
      body: { request_id: "alice-req-03", items: [{ amount: 80, category: "shopping", note: "koshary place" }] },
    })).json()) as { saved: ExpenseRow[] }).saved;
    await req(`/api/expenses/${saved[0]!.id}`, a.cookie, { method: "PATCH", body: { fields: { category: "food_dining" } } });
    const alice = await env.DB.prepare("SELECT category FROM merchant_map WHERE user_id = ? AND term = 'koshary place'").bind(a.id).first();
    const bob = await env.DB.prepare("SELECT category FROM merchant_map WHERE user_id = ? AND term = 'koshary place'").bind(b.id).first();
    expect(alice).toEqual({ category: "food_dining" });
    expect(bob).toBeNull();
  });

  it("an MCP token reaches only its owner's data", async () => {
    const a = await account("alice");
    const b = await account("bob");
    await add(a.cookie, "alice-req-04", "alice dinner", 500);
    const token = ((await (await req("/api/auth/token", b.cookie, { body: {} })).json()) as { token: string }).token;
    const res = await req("/mcp", "", { bearer: token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_expenses", arguments: {} } } });
    const body = (await res.json()) as { result: { structuredContent: { expenses: unknown[] } } };
    expect(body.result.structuredContent.expenses).toEqual([]);
  });

  it("rows left from before multi-user ('unclaimed') are invisible to every account", async () => {
    await env.DB.prepare(
      `INSERT INTO expenses (id, user_id, amount, currency, category, expense_date, note, needs_review, source, request_id, line_index, created_at)
       VALUES ('OLD1', 'unclaimed', 75, 'EGP', 'food_dining', '2026-10-15', 'old coffee', 0, 'chat', 'old-req', 0, '2026-10-15T10:00:00Z')`,
    ).run();
    const a = await account("alice");
    const rows = (await (await req("/api/expenses/recent", a.cookie)).json()) as ExpenseRow[];
    expect(rows).toEqual([]);
  });
});

describe("shared AI quota", () => {
  it("caps LLM messages per day across all accounts; the fast path keeps working", async () => {
    const a = await account("alice");
    const b = await account("bob");
    const e = { ...env, LLM_RATE_PER_DAY: "1" };
    const llm = (async () => Response.json({ choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;
    const first = await runChat(e, a.id, { message: "how am I doing?", request_id: "quota-req-1", history: [] }, { now: () => NOW, fetchImpl: llm });
    expect(first.error).toBeUndefined();
    const second = await runChat(e, b.id, { message: "how am I doing?", request_id: "quota-req-2", history: [] }, { now: () => NOW, fetchImpl: llm });
    expect(second.error).toMatch(/shared AI quota/);
    await env.DB.prepare("INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', 'coffee', 'food_dining', 1, 'x')").run();
    const fast = await runChat(e, b.id, { message: "coffee 30", request_id: "quota-req-3", history: [] }, { now: () => NOW, fetchImpl: llm });
    expect(fast.path).toBe("fast");
    expect(fast.saved).toHaveLength(1);
  });
});

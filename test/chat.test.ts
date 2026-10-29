import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ITERATIONS, runChat } from "../src/chat/loop";
import type { ChatMessage, ToolCall } from "../src/chat/llm";
import worker from "../src/index";
import type { ExpenseRow } from "../src/tools/types";
import { cairo, NOW, resetDb, TEST_USER } from "./helpers";

beforeEach(resetDb);

type Step = { content?: string | null; tool_calls?: { name: string; args: unknown; raw?: string }[] } | { status: number };

/** A fake OpenAI-compatible endpoint that plays back scripted assistant turns. */
function scriptedLlm(steps: Step[]) {
  const requests: { messages: ChatMessage[]; tools: { function: { name: string } }[]; model: string }[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if ("status" in step) return new Response("rate limited", { status: step.status });
    const tool_calls: ToolCall[] | undefined = step.tool_calls?.map((c, k) => ({
      id: `call_${i}_${k}`,
      type: "function",
      function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args) },
    }));
    return Response.json({ choices: [{ message: { role: "assistant", content: step.content ?? null, tool_calls } }] });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, calls: () => i };
}

const deps = (llm: ReturnType<typeof scriptedLlm>, now: Date = NOW) => ({ fetchImpl: llm.fetchImpl, now: () => now });
const rows = async () =>
  (await env.DB.prepare("SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY line_index").all<ExpenseRow>()).results;

describe("/chat tool-calling loop", () => {
  it("records a multi-item message; code supplies the date and the status lines", async () => {
    const llm = scriptedLlm([
      {
        tool_calls: [
          {
            name: "add_expense",
            args: {
              items: [
                { amount: 200, category: "food_dining", note: "coffee" },
                { amount: 400, category: "groceries", note: "vegs" },
              ],
            },
          },
        ],
      },
      { content: "Saved coffee and vegs." },
    ]);
    const res = await runChat(env, TEST_USER, { message: "coffee 200, vegs 400", request_id: "req-chat-001", history: [] }, deps(llm));

    expect(res.reply).toBe("Saved coffee and vegs.");
    expect(res.changed).toBe(true);
    expect(res.saved.map((s) => [s.note, s.amount, s.expense_date, s.source])).toEqual([
      ["coffee", 200, "2026-10-19", "chat"],
      ["vegs", 400, "2026-10-19", "chat"],
    ]);
    expect(res.status_lines).toEqual([
      "Added coffee 200. Food & Dining: 200 spent this month (no budget set).",
      "Added vegs 400. Groceries: 400 spent this month (no budget set).",
    ]);

    // The model got today's date from code, the category keys, and the tool schemas.
    const first = llm.requests[0]!;
    expect(first.messages[0]!.role).toBe("system");
    expect((first.messages[0] as { content: string }).content).toContain("Today is Monday 2026-10-19");
    expect((first.messages[0] as { content: string }).content).toContain("food_dining: Food & Dining");
    expect(first.tools.map((t) => t.function.name)).toContain("add_expense");
    // Second turn carries the tool result back to the model.
    expect(llm.requests[1]!.messages.at(-1)!.role).toBe("tool");

    const log = await env.DB.prepare("SELECT * FROM logs WHERE request_id = ?").bind("req-chat-001").first<{
      path: string;
      tool_calls: string;
      user_text: string;
      response: string;
    }>();
    expect(log?.path).toBe("llm");
    expect(log?.user_text).toBe("coffee 200, vegs 400");
    expect(JSON.parse(log!.tool_calls)[0].name).toBe("add_expense");
    expect(log?.response).toBeTruthy();
  });

  it("ignores any date the model invents: stored date comes from code (F2)", async () => {
    const llm = scriptedLlm([
      { tool_calls: [{ name: "add_expense", args: { items: [{ amount: 50, category: "food_dining", note: "tea", expense_date: "2024-01-01" }] } }] },
      { content: "ok" },
    ]);
    const late = cairo("2026-10-20T00:01", 3); // 21:01 UTC on Oct 19
    const res = await runChat(env, TEST_USER, { message: "tea 50", request_id: "req-chat-date", history: [] }, deps(llm, late));
    expect(res.saved[0]!.expense_date).toBe("2026-10-20");
  });

  it("a retry with the same request_id replays the response without calling the LLM (D12)", async () => {
    const llm = scriptedLlm([
      { tool_calls: [{ name: "add_expense", args: { items: [{ amount: 200, category: "food_dining", note: "coffee" }] } }] },
      { content: "Saved." },
    ]);
    const req = { message: "coffee 200", request_id: "req-chat-retry", history: [] };
    const a = await runChat(env, TEST_USER, req, deps(llm));
    const callsAfterFirst = llm.calls();
    const b = await runChat(env, TEST_USER, req, deps(llm));
    expect(llm.calls()).toBe(callsAfterFirst);
    expect(b.replayed).toBe(true);
    expect(b.saved.map((s) => s.id)).toEqual(a.saved.map((s) => s.id));
    expect(await rows()).toHaveLength(1);
  });

  it("non-expense messages never write", async () => {
    const llm = scriptedLlm([{ content: "Hi! Tell me what you spent." }]);
    const res = await runChat(env, TEST_USER, { message: "hello", request_id: "req-chat-hello", history: [] }, deps(llm));
    expect(res).toMatchObject({ reply: "Hi! Tell me what you spent.", saved: [], changed: false, pending: null });
    expect(await rows()).toHaveLength(0);
  });

  it("large amounts come back as pending; the Confirm button saves them through /api (D11)", async () => {
    const llm = scriptedLlm([
      {
        tool_calls: [
          {
            name: "add_expense",
            args: { items: [{ amount: 15000, category: "shopping", note: "tv" }, { amount: 30, category: "food_dining", note: "water" }] },
          },
        ],
      },
      { content: "That's a big one: press Confirm to save." },
    ]);
    const res = await runChat(env, TEST_USER, { message: "tv 15000, water 30", request_id: "req-chat-big", history: [] }, deps(llm));
    expect(res.saved).toEqual([]);
    expect(res.changed).toBe(false);
    expect(res.pending?.request_id).toBe("req-chat-big:confirm");
    expect(res.pending?.items.map((i) => [i.note, i.date_token])).toEqual([
      ["tv", "date:2026-10-19"],
      ["water", "date:2026-10-19"],
    ]);
    expect(await rows()).toHaveLength(0);

    const confirm = () =>
      worker.fetch(
        new Request("http://localhost/api/expenses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request_id: res.pending!.request_id, items: res.pending!.items, confirmed: true }),
        }),
        env,
      );
    const r = await confirm();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("saved");
    await confirm(); // double click
    expect((await rows()).map((x) => x.note)).toEqual(["tv", "water"]);
  });

  it("bad JSON from the model is reported back and the model can retry", async () => {
    const llm = scriptedLlm([
      { tool_calls: [{ name: "add_expense", args: null, raw: "{items: [oops" }] },
      { tool_calls: [{ name: "add_expense", args: { items: [{ amount: 85, category: "transport_fuel", note: "uber", date_token: "yesterday" }] } }] },
      { content: "Saved." },
    ]);
    const res = await runChat(env, TEST_USER, { message: "uber 85 yesterday", request_id: "req-chat-badjson", history: [] }, deps(llm));
    expect(JSON.parse((llm.requests[1]!.messages.at(-1) as { content: string }).content)).toMatchObject({
      ok: false,
      error: "arguments were not valid JSON",
    });
    expect(res.saved.map((s) => s.expense_date)).toEqual(["2026-10-18"]);
  });

  it("schema violations go back to the model as errors, nothing is written", async () => {
    const llm = scriptedLlm([
      { tool_calls: [{ name: "add_expense", args: { items: [{ amount: 10, category: "pets", note: "cat food" }] } }] },
      { content: "Which category is cat food?" },
    ]);
    const res = await runChat(env, TEST_USER, { message: "cat food 10", request_id: "req-chat-badcat", history: [] }, deps(llm));
    expect(res.saved).toEqual([]);
    const back = JSON.parse((llm.requests[1]!.messages.at(-1) as { content: string }).content);
    expect(back.result.status).toBe("error");
    expect(back.result.errors[0]).toMatch(/unknown category 'pets'.*Groceries \(groceries\)/);
  });

  it("stops at the iteration cap", async () => {
    const llm = scriptedLlm([{ tool_calls: [{ name: "budget_status", args: {} }] }]);
    const res = await runChat(env, TEST_USER, { message: "loop forever", request_id: "req-chat-loop", history: [] }, deps(llm));
    expect(llm.calls()).toBe(MAX_ITERATIONS);
    expect(res.error).toBe("iteration cap reached");
  });

  it("LLM failure: clear error, nothing saved, and a retry calls the LLM again", async () => {
    const llm = scriptedLlm([{ status: 429 }]);
    const req = { message: "coffee 200", request_id: "req-chat-429", history: [] };
    const noFallback = { ...env, LLM_FALLBACK_MODEL: "" };
    const res = await runChat(noFallback, TEST_USER, req, deps(llm));
    expect(res.error).toMatch(/rate limit/);
    expect(res.reply).toMatch(/Nothing was saved/);
    await runChat(noFallback, TEST_USER, req, deps(llm));
    expect(llm.calls()).toBe(2);
  });

  it("retries once on a 5xx", async () => {
    const llm = scriptedLlm([{ status: 503 }, { content: "Hi" }]);
    const res = await runChat(env, TEST_USER, { message: "hi", request_id: "req-chat-503", history: [] }, deps(llm));
    expect(res.reply).toBe("Hi");
  });

  it("explains a missing API key", async () => {
    const llm = scriptedLlm([{ content: "unused" }]);
    const res = await runChat({ ...env, LLM_API_KEY: "" }, TEST_USER, { message: "hi", request_id: "req-chat-nokey", history: [] }, deps(llm));
    expect(res.error).toMatch(/LLM_API_KEY/);
    expect(llm.calls()).toBe(0);
  });

  it("undo by chat marks the response as changed", async () => {
    const add = scriptedLlm([
      { tool_calls: [{ name: "add_expense", args: { items: [{ amount: 200, category: "food_dining", note: "coffee" }] } }] },
      { content: "Saved." },
    ]);
    await runChat(env, TEST_USER, { message: "coffee 200", request_id: "req-chat-u1", history: [] }, deps(add));
    const undo = scriptedLlm([{ tool_calls: [{ name: "undo_request", args: {} }] }, { content: "Undone." }]);
    const res = await runChat(env, TEST_USER, { message: "undo that", request_id: "req-chat-u2", history: [] }, deps(undo));
    expect(res.changed).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it("passes the chat history so follow-up answers have context", async () => {
    const llm = scriptedLlm([{ content: "ok" }]);
    await runChat(env, TEST_USER,
      {
        message: "200",
        request_id: "req-chat-hist",
        history: [
          { role: "user", content: "coffee" },
          { role: "assistant", content: "How much was the coffee?" },
        ],
      },
      deps(llm),
    );
    expect(llm.requests[0]!.messages.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user"]);
  });
});

describe("HTTP routes", () => {
  const call = (path: string, init: RequestInit = {}, e: typeof env = env) => worker.fetch(new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) } }), e);

  it("once an account exists, /api and /chat need a sign-in even on localhost", async () => {
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('u1', 'someone', 'x', 'now', 'now')").run();
    expect((await call("/api/budget-status")).status).toBe(401);
    expect((await call("/chat", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/api/budget-status", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("validates /chat bodies", async () => {
    expect((await call("/chat", { method: "POST", body: JSON.stringify({ message: "" }) })).status).toBe(400);
    expect((await call("/chat", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await call("/chat")).status).toBe(405);
  });

  it("budget endpoints", async () => {
    const put = await call("/api/budgets", { method: "PUT", body: JSON.stringify({ category: "groceries", amount: 6000 }) });
    expect(put.status).toBe(200);
    const status = (await (await call("/api/budget-status?month=2026-10")).json()) as { rows: { category: string; budget: number }[] };
    expect(status.rows.find((r) => r.category === "groceries")!.budget).toBe(6000);
    expect((await call("/api/budgets", { method: "PUT", body: JSON.stringify({ category: "pets", amount: 1 }) })).status).toBe(400);
  });

  it("expenses: add, recent, edit, delete, undo", async () => {
    const add = await call("/api/expenses", {
      method: "POST",
      body: JSON.stringify({ request_id: "api-add-0001", items: [{ amount: 120, category: "food_dining", note: "lunch" }] }),
    });
    const saved = ((await add.json()) as { saved: ExpenseRow[] }).saved;
    expect(saved).toHaveLength(1);
    const id = saved[0]!.id;

    const recent = (await (await call("/api/expenses/recent")).json()) as ExpenseRow[];
    expect(recent.map((r) => r.id)).toEqual([id]);

    const patch = await call(`/api/expenses/${id}`, { method: "PATCH", body: JSON.stringify({ fields: { amount: 130 } }) });
    expect(((await patch.json()) as { updated: ExpenseRow }).updated.amount).toBe(130);

    expect((await call(`/api/expenses/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/expenses/${id}`, { method: "DELETE" })).status).toBe(400);

    const undo = await call("/api/undo", { method: "POST", body: JSON.stringify({ request_id: "api-add-0001" }) });
    expect(((await undo.json()) as { action: string }).action).toBe("restored");

    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM logs WHERE path = 'api'").first<{ n: number }>();
    expect(logs!.n).toBeGreaterThanOrEqual(4);
  });

  it("rejects bad add requests", async () => {
    const r = await call("/api/expenses", { method: "POST", body: JSON.stringify({ request_id: "x", items: [] }) });
    expect(r.status).toBe(400);
  });

  it("unknown API paths are 404", async () => {
    expect((await call("/api/nope")).status).toBe(404);
  });
});

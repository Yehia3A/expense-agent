import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fastPath } from "../src/chat/fastpath";
import type { ChatMessage } from "../src/chat/llm";
import { dropNulls, runChat, trimHistory } from "../src/chat/loop";
import { addExpenses } from "../src/tools/expenses";
import { callTool } from "../src/tools/registry";
import { makeCtx, NOW, resetDb, TEST_USER } from "./helpers";

// D48: the chat can edit expenses it (or the user) logged earlier, and sees the whole conversation.
beforeEach(resetDb);

type Call = { name: string; args: unknown };
function scriptedLlm(steps: { content?: string; tool_calls?: Call[] }[]) {
  const requests: { messages: ChatMessage[] }[] = [];
  let i = 0;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    const step = steps[Math.min(i++, steps.length - 1)]!;
    const tool_calls = step.tool_calls?.map((c, k) => ({ id: `c${i}_${k}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    return Response.json({ choices: [{ message: { role: "assistant", content: step.content ?? null, tool_calls } }] });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

async function logCoffee() {
  const r = await addExpenses(makeCtx({ requestId: "edit-seed" }), [{ amount: 200, category: "food_dining", note: "coffee" }]);
  if (r.status !== "saved") throw new Error("seed failed");
  return r.saved[0]!.id;
}

describe("editing expenses from chat", () => {
  it("shows the model recent expenses with ids, and an update with null fields works", async () => {
    const id = await logCoffee();
    const llm = scriptedLlm([
      // Models often fill every field, leaving the unchanged ones null.
      { tool_calls: [{ name: "update_expense", args: { id, fields: { amount: 250, currency: null, category: null, note: null, date_token: null, details: null } } }] },
      { content: "Changed the coffee to 250." },
    ]);
    const res = await runChat(env, TEST_USER, { message: "make the coffee 250", request_id: "edit-1", history: [] }, { now: () => NOW, fetchImpl: llm.fetchImpl });

    const context = llm.requests[0]!.messages.map((m) => m.content).join("\n");
    expect(context).toContain(`id=${id} | 2026-10-19 | 200 EGP | food_dining | coffee`);
    expect(res.changed).toBe(true);
    expect(res.memo).toBe(`updated: id=${id} | 2026-10-19 | 250 EGP | food_dining | coffee`);
    const row = await env.DB.prepare("SELECT amount, note, category FROM expenses WHERE id = ?").bind(id).first();
    expect(row).toEqual({ amount: 250, note: "coffee", category: "food_dining" });
  });

  it("saved rows come back in the memo, so the next message can refer to them", async () => {
    const llm = scriptedLlm([{ tool_calls: [{ name: "add_expense", args: { items: [{ amount: 90, category: "transport_fuel", note: "uber" }] } }] }, { content: "Saved." }]);
    const res = await runChat(env, TEST_USER, { message: "uber 90 to work", request_id: "edit-2", history: [] }, { now: () => NOW, fetchImpl: llm.fetchImpl });
    expect(res.memo).toMatch(/^saved: id=\w+ \| 2026-10-19 \| 90 EGP \| transport_fuel \| uber$/);
  });

  it("the whole conversation goes to the model, not just the last few turns", async () => {
    const history = Array.from({ length: 30 }, (_, k) => ({ role: k % 2 ? ("assistant" as const) : ("user" as const), content: `turn ${k}` }));
    const llm = scriptedLlm([{ content: "OK." }]);
    await runChat(env, TEST_USER, { message: "and the first one?", request_id: "edit-3", history }, { now: () => NOW, fetchImpl: llm.fetchImpl });
    const sent = llm.requests[0]!.messages.filter((m) => m.role !== "system").map((m) => m.content);
    expect(sent).toEqual([...history.map((h) => h.content), "and the first one?"]);
  });

  it("very long chats drop their oldest turns and still start with a user turn", () => {
    const h = [
      { role: "user" as const, content: "a".repeat(50) },
      { role: "assistant" as const, content: "b".repeat(50) },
      { role: "user" as const, content: "c".repeat(30) },
      { role: "assistant" as const, content: "d".repeat(30) },
    ];
    expect(trimHistory(h, 100).map((m) => m.content[0])).toEqual(["c", "d"]);
    expect(trimHistory(h, 1000)).toEqual(h);
  });

  it("dropNulls removes null fields at every level", () => {
    expect(dropNulls({ id: "x", fields: { amount: 5, note: null }, items: [{ a: null, b: 1 }] })).toEqual({ id: "x", fields: { amount: 5 }, items: [{ b: 1 }] });
  });

  it("list_expenses can search by item words, and the model gets short lines", async () => {
    const id = await logCoffee();
    await addExpenses(makeCtx({ requestId: "edit-seed2" }), [{ amount: 400, category: "groceries", note: "vegs" }]);
    const r = await callTool(makeCtx(), "list_expenses", { search: "COFF" });
    expect(r.ok && (r.result as { expenses: { id: string }[] }).expenses.map((e) => e.id)).toEqual([id]);

    const llm = scriptedLlm([{ tool_calls: [{ name: "list_expenses", args: { search: "coffee" } }] }, { content: "Found it." }]);
    await runChat(env, TEST_USER, { message: "find my coffee", request_id: "edit-4", history: [] }, { now: () => NOW, fetchImpl: llm.fetchImpl });
    const toolMsg = llm.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(JSON.parse(toolMsg.content as string).result.expenses).toEqual([`id=${id} | 2026-10-19 | 200 EGP | food_dining | coffee`]);
  });

  it("corrections never go through the no-AI path as new expenses", async () => {
    await env.DB.prepare("INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', 'coffee', 'food_dining', 1, 'x')").run();
    expect(await fastPath(env.DB, TEST_USER, "coffee 200")).not.toBeNull();
    for (const msg of ["actually coffee 300", "make the coffee 250", "coffee 250 instead", "خليها 250", "غير القهوة 250", "5aleha 250"]) {
      expect(await fastPath(env.DB, TEST_USER, msg), msg).toBeNull();
    }
  });
});

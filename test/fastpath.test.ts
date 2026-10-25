import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fastPath, parseFast } from "../src/chat/fastpath";
import { runChat } from "../src/chat/loop";
import { updateExpense } from "../src/tools/expenses";
import { lookupCategory } from "../src/tools/merchants";
import type { ExpenseRow } from "../src/tools/types";
import { NOW, resetDb, TEST_USER, makeCtx } from "./helpers";

async function seed(terms: Record<string, string>) {
  await env.DB.batch(
    Object.entries(terms).map(([term, category]) =>
      env.DB.prepare("INSERT OR REPLACE INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', ?, ?, 1, 'seed')").bind(term, category),
    ),
  );
}

beforeEach(async () => {
  await resetDb();
  await seed({ coffee: "food_dining", vegs: "groceries", uber: "transport_fuel", gym: "sports", thndr: "other", "قهوة": "food_dining", tea: "food_dining" });
});

describe("parseFast (plan 7.2 path A)", () => {
  it.each([
    ["coffee 200, vegs 400", [["coffee", 200], ["vegs", 400]], undefined],
    ["coffee 200 and vegs 400", [["coffee", 200], ["vegs", 400]], undefined],
    ["coffee 200\nvegs 400", [["coffee", 200], ["vegs", 400]], undefined],
    ["coffee 200 w tea 30", [["coffee", 200], ["tea", 30]], undefined],
    ["Coffee 200 EGP", [["coffee", 200]], undefined],
    ["coffee: 200", [["coffee", 200]], undefined],
    ["200 coffee", [["coffee", 200]], undefined],
    ["gym 2k", [["gym", 2000]], undefined],
    ["coffee 12.5", [["coffee", 12.5]], undefined],
    ["uber 85 yesterday", [["uber", 85]], "yesterday"],
    ["embare7 uber 85", [["uber", 85]], "yesterday"],
    ["today coffee 200", [["coffee", 200]], undefined],
    ["قهوة ٢٠٠", [["قهوة", 200]], undefined],
    ["squash court 350", [["squash court", 350]], undefined],
  ])("%j", (msg, items, date) => {
    const r = parseFast(msg);
    expect(r?.items.map((i) => [i.note, i.amount])).toEqual(items);
    expect(r?.date_token).toBe(date);
  });

  it.each([
    "paid 400 for vegs",
    "coffee",
    "200",
    "hello",
    "how much did I spend on coffee?",
    "what did I spend most on last month",
    "set groceries to 6000",
    "undo",
    "delete the coffee",
    "coffee 1,200",
    "coffee 200 last friday",
    "uber 85 on monday",
    "uber 85 3 days ago",
    "coffee 200 on the 5th",
    "coffee 200 on 12/10",
    "coffee $5",
    "coffee 5 usd",
    "2 coffees 100",
    "coffee 200 today and vegs 50 yesterday",
    "my weekly groceries were around 2000",
    "coffee 0",
    "coffee for me and my friends 200 each",
  ])("refuses %j", (msg) => {
    expect(parseFast(msg)).toBeNull();
  });
});

describe("merchant cache (path C)", () => {
  it("exact term, then agreeing words, never disagreeing ones", async () => {
    expect(await lookupCategory(env.DB, TEST_USER, "Coffee")).toBe("food_dining");
    expect(await lookupCategory(env.DB, TEST_USER, "uber home")).toBe("transport_fuel");
    expect(await lookupCategory(env.DB, TEST_USER, "coffee uber")).toBeNull();
    expect(await lookupCategory(env.DB, TEST_USER, "mystery")).toBeNull();
  });

  it("needs every item categorized, otherwise the LLM handles the message", async () => {
    expect(await fastPath(env.DB, TEST_USER, "coffee 200, vegs 400")).toHaveLength(2);
    expect(await fastPath(env.DB, TEST_USER, "coffee 200, mystery 50")).toBeNull();
  });
});

type Step = { content?: string; tool_calls?: { name: string; args: unknown }[] } | { status: number };
function llm(steps: Step[]) {
  const models: string[] = [];
  let i = 0;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    models.push(JSON.parse(init.body as string).model);
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if ("status" in s) return new Response("quota", { status: s.status });
    return Response.json({
      choices: [
        {
          message: {
            content: s.content ?? null,
            tool_calls: s.tool_calls?.map((c, k) => ({ id: `c${i}${k}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
          },
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 50 },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, models, calls: () => i };
}
const chat = (message: string, id: string, l: ReturnType<typeof llm>, e: typeof env = env) =>
  runChat(e, TEST_USER, { message, request_id: id, history: [] }, { fetchImpl: l.fetchImpl, now: () => NOW });

describe("fast path inside /chat", () => {
  it("saves known items without calling the LLM and logs path 'regex'", async () => {
    const l = llm([{ content: "unused" }]);
    const r = await chat("coffee 200, vegs 400", "fast-0001", l);
    expect(l.calls()).toBe(0);
    expect(r).toMatchObject({ path: "fast", reply: "Saved.", changed: true });
    expect(r.saved.map((s) => [s.note, s.category, s.expense_date])).toEqual([
      ["coffee", "food_dining", "2026-10-19"],
      ["vegs", "groceries", "2026-10-19"],
    ]);
    expect(r.status_lines).toHaveLength(2);
    const log = await env.DB.prepare("SELECT path FROM logs WHERE request_id = 'fast-0001'").first<{ path: string }>();
    expect(log?.path).toBe("regex");
  });

  it("applies the same confirmation rules", async () => {
    const r = await chat("gym 15000", "fast-0002", llm([{ content: "unused" }]));
    expect(r.saved).toEqual([]);
    expect(r.pending?.items[0]).toMatchObject({ note: "gym", amount: 15000 });
  });

  it("resolves 'yesterday' in code", async () => {
    const r = await chat("uber 85 yesterday", "fast-0003", llm([{ content: "unused" }]));
    expect(r.saved[0]!.expense_date).toBe("2026-10-18");
  });

  it("unknown items go to the LLM; what it saves is learned for next time", async () => {
    const l = llm([
      { tool_calls: [{ name: "add_expense", args: { items: [{ amount: 80, category: "food_dining", note: "koshary place" }] } }] },
      { content: "Saved." },
    ]);
    const first = await chat("koshary place 80", "fast-0004", l);
    expect(first.path).toBe("llm");
    expect(first.usage).toEqual({ prompt_tokens: 2000, completion_tokens: 100, calls: 2 });
    const second = await chat("koshary place 60", "fast-0005", llm([{ content: "unused" }]));
    expect(second.path).toBe("fast");
    expect(second.saved[0]!.category).toBe("food_dining");
  });

  it("learns from corrections and never from rows flagged for review", async () => {
    const l = llm([
      { tool_calls: [{ name: "add_expense", args: { items: [{ amount: 50, category: "other", note: "pens" }] } }] },
      { content: "Saved." },
    ]);
    const r = await chat("pens 50", "fast-0006", l);
    expect(await lookupCategory(env.DB, TEST_USER, "pens")).toBeNull(); // flagged 'other' is a guess
    await updateExpense(makeCtx(), (r.saved[0] as ExpenseRow).id, { category: "shopping" });
    expect(await lookupCategory(env.DB, TEST_USER, "pens")).toBe("shopping");
  });

  it("FAST_PATH=off sends everything to the LLM (eval baseline)", async () => {
    const l = llm([{ content: "ok" }]);
    const r = await chat("coffee 200", "fast-0007", l, { ...env, FAST_PATH: "off" });
    expect(r.path).toBe("llm");
    expect(l.calls()).toBe(1);
  });
});

describe("fallback model (R2)", () => {
  it("switches to LLM_FALLBACK_MODEL when the main model returns 429", async () => {
    const l = llm([{ status: 429 }, { content: "hi from fallback" }]);
    const e = { ...env, LLM_MODEL: "big-model", LLM_FALLBACK_MODEL: "small-model" };
    const r = await chat("hello", "fallback-0001", l, e);
    expect(l.models).toEqual(["big-model", "small-model"]);
    expect(r.reply).toBe("hi from fallback");
    expect(r.model).toContain("small-model");
  });

  it("without a fallback, a 429 is reported", async () => {
    const r = await chat("hello", "fallback-0002", llm([{ status: 429 }]), { ...env, LLM_FALLBACK_MODEL: "" });
    expect(r.error).toMatch(/rate limit/);
  });
});

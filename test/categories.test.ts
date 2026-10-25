import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runChat } from "../src/chat/loop";
import { handle } from "../src/index";
import { budgetStatus } from "../src/tools/budgets";
import { callTool } from "../src/tools/registry";
import { makeCtx, NOW, resetDb } from "./helpers";

// D41: every account sets up its own categories (suggested or typed), up to 10 plus Other.
beforeEach(resetDb);

const HOST = "https://app.example.workers.dev";
let ip = 0;
function req(path: string, cookie: string, init: { method?: string; body?: unknown } = {}) {
  return handle(
    new Request(`${HOST}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", "cf-connecting-ip": `10.9.0.${++ip % 250}`, ...(cookie ? { cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    { now: () => NOW },
  );
}
async function newAccount(username = "newbie") {
  const res = await req("/api/auth/signup", "", { body: { username, password: "long enough password" } });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const id = (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: string }>())!.id;
  return { cookie, id };
}
type Payload = { needs_setup: boolean; max: number; presets: { key: string; name: string }[]; categories: { key: string; name: string; budget: number | null; is_other: boolean }[] };
const getCats = async (cookie: string) => (await (await req("/api/categories", cookie)).json()) as Payload;
const putCats = (cookie: string, categories: unknown[], other_budget?: number | null) =>
  req("/api/categories", cookie, { method: "PUT", body: { categories, ...(other_budget !== undefined ? { other_budget } : {}) } });

describe("setting up categories", () => {
  it("a new account starts with only Other, sees suggestions, and is asked to set up", async () => {
    const { cookie } = await newAccount();
    const me = (await (await req("/api/auth/me", cookie)).json()) as { needs_setup: boolean };
    expect(me.needs_setup).toBe(true);
    const p = await getCats(cookie);
    expect(p.needs_setup).toBe(true);
    expect(p.max).toBe(10);
    expect(p.categories.map((c) => c.key)).toEqual(["other"]);
    expect(p.presets.map((x) => x.name)).toContain("Investments & Savings");
    expect(p.presets.map((x) => x.name)).toContain("Groceries");
  });

  it("saves suggested and custom categories with monthly budgets, in the order given, Other last", async () => {
    const { cookie } = await newAccount();
    const res = await putCats(cookie, [{ name: "Groceries", budget: 4000 }, { name: "Car", budget: 1500 }, { name: "Investments & Savings", budget: 10000 }], 500);
    expect(res.status).toBe(200);
    const p = (await res.json()) as Payload;
    expect(p.needs_setup).toBe(false);
    expect(p.categories.map((c) => [c.key, c.name, c.budget])).toEqual([
      ["groceries", "Groceries", 4000],
      ["car", "Car", 1500],
      ["investments", "Investments & Savings", 10000],
      ["other", "Other", 500],
    ]);
    expect(((await (await req("/api/auth/me", cookie)).json()) as { needs_setup: boolean }).needs_setup).toBe(false);
  });

  it("budgets carry forward to the next months", async () => {
    const { cookie, id } = await newAccount();
    await putCats(cookie, [{ name: "Groceries", budget: 4000 }]);
    const nov = await budgetStatus(env.DB, id, "2026-11");
    expect(nov.rows.find((r) => r.category === "groceries")!.budget).toBe(4000);
  });

  it.each([
    [Array.from({ length: 11 }, (_, i) => ({ name: `Cat ${i}` })), /Up to 10/],
    [[{ name: "Food" }, { name: "food" }], /listed twice/],
    [[{ name: "Other" }], /already included/],
    [[{ name: "x".repeat(36) }], /too long/],
  ])("refuses bad lists %#", async (cats, msg) => {
    const { cookie } = await newAccount();
    const res = await putCats(cookie, cats);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(msg);
  });

  it("names can be up to 35 characters", async () => {
    const { cookie } = await newAccount();
    const name = "Kids school fees and activities 2026"; // 36
    expect((await putCats(cookie, [{ name }])).status).toBe(400);
    const ok = await putCats(cookie, [{ name: name.slice(0, 35) }]);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Payload).categories[0]!.name).toBe(name.slice(0, 35));
  });

  it("names in any language work; the model and the API can use the name or the key", async () => {
    const { cookie, id } = await newAccount();
    const p = (await (await putCats(cookie, [{ name: "مواصلات", budget: 800 }])).json()) as Payload;
    const key = p.categories[0]!.key;
    expect(key).toMatch(/^c_[a-z0-9]+$/);
    const ctx = makeCtx({ userId: id });
    const byName = await callTool(ctx, "add_expense", { items: [{ amount: 50, category: "مواصلات", note: "taxi" }] });
    expect((byName as { result: { saved: { category: string }[] } }).result.saved[0]!.category).toBe(key);
  });
});

describe("editing categories later", () => {
  it("renaming keeps the key, so past expenses stay in it", async () => {
    const { cookie, id } = await newAccount();
    await putCats(cookie, [{ name: "Car", budget: 1000 }]);
    await callTool(makeCtx({ userId: id }), "add_expense", { items: [{ amount: 300, category: "car", note: "oil change" }] });
    const p = (await (await putCats(cookie, [{ key: "car", name: "My car", budget: 1200 }])).json()) as Payload;
    expect(p.categories[0]).toMatchObject({ key: "car", name: "My car", budget: 1200 });
    const s = await budgetStatus(env.DB, id, "2026-10");
    expect(s.rows.find((r) => r.category === "car")).toMatchObject({ display_name: "My car", spent: 300, budget: 1200 });
  });

  it("removing a used category hides it but keeps its spending; an unused one is deleted", async () => {
    const { cookie, id } = await newAccount();
    await putCats(cookie, [{ name: "Car" }, { name: "Gym" }, { name: "Groceries" }]);
    await callTool(makeCtx({ userId: id }), "add_expense", { items: [{ amount: 300, category: "car", note: "fuel" }] });
    const p = (await (await putCats(cookie, [{ key: "groceries", name: "Groceries" }])).json()) as Payload;
    expect(p.categories.map((c) => c.key)).toEqual(["groceries", "other"]);
    const rows = await env.DB.prepare("SELECT key, is_active FROM user_categories WHERE user_id = ? ORDER BY key").bind(id).all();
    expect(rows.results).toEqual([
      { key: "car", is_active: 0 },
      { key: "groceries", is_active: 1 },
      { key: "other", is_active: 1 },
    ]);
    const s = await budgetStatus(env.DB, id, "2026-10");
    expect(s.rows.find((r) => r.category === "car")).toMatchObject({ spent: 300, budget: null });
    expect(s.total.spent).toBe(300);
    // A removed category can't take new expenses.
    const again = await callTool(makeCtx({ userId: id }), "add_expense", { items: [{ amount: 10, category: "car", note: "x" }] });
    expect((again as { result: { status: string } }).result.status).toBe("error");
  });

  it("adding a removed name back brings the old category (and its history) back", async () => {
    const { cookie, id } = await newAccount();
    await putCats(cookie, [{ name: "Car" }]);
    await callTool(makeCtx({ userId: id }), "add_expense", { items: [{ amount: 300, category: "car", note: "fuel" }] });
    await putCats(cookie, []);
    const p = (await (await putCats(cookie, [{ name: "car" }])).json()) as Payload;
    expect(p.categories[0]!.key).toBe("car");
  });
});

describe("categories in chat and MCP", () => {
  it("the fast path uses shared words only for categories the account has", async () => {
    const a = await newAccount("withgroceries");
    const b = await newAccount("custom");
    await env.DB.prepare("INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', 'vegs', 'groceries', 1, 'x')").run();
    await putCats(a.cookie, [{ name: "Groceries" }]);
    await putCats(b.cookie, [{ name: "Supermarket" }]);
    const fast = await runChat(env, a.id, { message: "vegs 300", request_id: "cat-chat-1", history: [] }, { now: () => NOW });
    expect(fast).toMatchObject({ path: "fast" });
    expect(fast.saved[0]!.category).toBe("groceries");
    const llm = (async () => Response.json({ choices: [{ message: { content: "Which category?" } }] })) as unknown as typeof fetch;
    const viaLlm = await runChat(env, b.id, { message: "vegs 300", request_id: "cat-chat-2", history: [] }, { now: () => NOW, fetchImpl: llm });
    expect(viaLlm.path).toBe("llm");
  });

  it("the model is told the account's own category names", async () => {
    const a = await newAccount();
    await putCats(a.cookie, [{ name: "Car" }, { name: "Groceries" }]);
    let prompt = "";
    const llm = (async (_u: string, init: RequestInit) => {
      prompt = JSON.parse(init.body as string).messages[0].content;
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    await runChat(env, a.id, { message: "hello", request_id: "cat-chat-3", history: [] }, { now: () => NOW, fetchImpl: llm });
    expect(prompt).toContain("- car: Car");
    expect(prompt).toContain("- groceries: Groceries (e.g. supermarket");
    expect(prompt).toContain("- other: Other");
    expect(prompt).not.toContain("food_dining");
  });

  it("list_categories returns the account's categories with this month's budgets", async () => {
    const a = await newAccount();
    await putCats(a.cookie, [{ name: "Car", budget: 900 }]);
    const r = await callTool(makeCtx({ userId: a.id }), "list_categories", {});
    expect((r as { result: { categories: unknown[] } }).result.categories).toEqual([
      { key: "car", name: "Car", budget: 900 },
      { key: "other", name: "Other", budget: null },
    ]);
  });
});

describe("smart categories (D43)", () => {
  const capture = () => {
    const prompts: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      prompts.push(JSON.parse(init.body as string).messages[0].content);
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    return { prompts, fetchImpl };
  };

  it("the model sees what you filed in each category and is told to prefer the most specific one", async () => {
    const a = await newAccount("snacker");
    await putCats(a.cookie, [{ name: "Food & Dining" }, { name: "Healthy snacks" }]);
    const ctx = makeCtx({ userId: a.id });
    await callTool(ctx, "add_expense", {
      items: [
        { amount: 45, category: "healthy_snacks", note: "protein bar" },
        { amount: 45, category: "healthy_snacks", note: "Protein bar" },
        { amount: 30, category: "healthy_snacks", note: "greek yogurt" },
        { amount: 200, category: "food_dining", note: "pizza" },
      ],
    });
    const c = capture();
    await runChat(env, a.id, { message: "how much on snacks?", request_id: "smart-1", history: [] }, { now: () => NOW, fetchImpl: c.fetchImpl });
    const p = c.prompts[0]!;
    expect(p).toContain("- healthy_snacks: Healthy snacks (you filed here: protein bar, greek yogurt)");
    expect(p).toContain("- food_dining: Food & Dining (you filed here: pizza)");
    expect(p).toMatch(/Prefer the most specific category/);
    expect(p).toMatch(/Healthy snacks.*protein bar, greek yogurt or a healthy drink goes there/);
  });

  it("categories without history still show their suggestion hints", async () => {
    const a = await newAccount("fresh");
    await putCats(a.cookie, [{ name: "Groceries" }]);
    const c = capture();
    await runChat(env, a.id, { message: "hi", request_id: "smart-2", history: [] }, { now: () => NOW, fetchImpl: c.fetchImpl });
    expect(c.prompts[0]).toContain("- groceries: Groceries (e.g. supermarket");
  });

  it("the fast path steps aside when an item shares a word with your own category", async () => {
    const a = await newAccount("snacker2");
    await env.DB.prepare("INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', 'snacks', 'food_dining', 1, 'x'), ('', 'pizza', 'food_dining', 1, 'x')").run();
    await putCats(a.cookie, [{ name: "Food & Dining" }, { name: "Healthy snacks" }]);
    const c = capture();
    // "snacks" would be Food & Dining by the shared words; with a "Healthy snacks" category the AI decides.
    const r1 = await runChat(env, a.id, { message: "snacks 40", request_id: "smart-3", history: [] }, { now: () => NOW, fetchImpl: c.fetchImpl });
    expect(r1.path).toBe("llm");
    // Unrelated items still use the fast path.
    const r2 = await runChat(env, a.id, { message: "pizza 150", request_id: "smart-4", history: [] }, { now: () => NOW, fetchImpl: c.fetchImpl });
    expect(r2).toMatchObject({ path: "fast" });
    expect(r2.saved[0]!.category).toBe("food_dining");
  });

  it("once you file an item in your own category, it goes straight there next time", async () => {
    const a = await newAccount("snacker3");
    await putCats(a.cookie, [{ name: "Food & Dining" }, { name: "Healthy snacks" }]);
    await callTool(makeCtx({ userId: a.id }), "add_expense", { items: [{ amount: 45, category: "healthy_snacks", note: "protein bar" }] });
    const r = await runChat(env, a.id, { message: "protein bar 50", request_id: "smart-5", history: [] }, { now: () => NOW });
    expect(r).toMatchObject({ path: "fast" });
    expect(r.saved[0]!.category).toBe("healthy_snacks");
  });
});

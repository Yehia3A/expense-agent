import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parseFast } from "../src/chat/fastpath";
import { systemPrompt } from "../src/chat/prompt";
import { handle } from "../src/index";
import { budgetStatus } from "../src/tools/budgets";
import { normalizeCurrency } from "../src/tools/currency";
import { addExpenses, quickItems } from "../src/tools/expenses";
import { makeCtx, NOW, resetDb } from "./helpers";

// D45: each account has its own currency; changing it relabels, never converts.
beforeEach(resetDb);

const HOST = "https://app.example.workers.dev";
let ip = 0;
function req(path: string, cookie: string, init: { method?: string; body?: unknown } = {}) {
  return handle(
    new Request(`${HOST}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", "cf-connecting-ip": `10.8.0.${++ip % 250}`, ...(cookie ? { cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    { now: () => NOW },
  );
}
async function newAccount(username = "abroad") {
  const res = await req("/api/auth/signup", "", { body: { username, password: "long enough password" } });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const id = (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: string }>())!.id;
  return { cookie, id };
}

describe("account currency", () => {
  it("accepts ISO codes in any case and rejects anything else", () => {
    expect(normalizeCurrency(" usd ")).toBe("USD");
    expect(normalizeCurrency("EGP")).toBe("EGP");
    expect(normalizeCurrency("kwd")).toBe("KWD");
    for (const bad of ["", "US", "dollars", "ZZZ", 5, null]) expect(normalizeCurrency(bad)).toBeNull();
  });

  it("new accounts start in EGP, and setup can pick another currency", async () => {
    const { cookie } = await newAccount();
    expect(((await (await req("/api/auth/me", cookie)).json()) as { currency: string }).currency).toBe("EGP");
    const res = await req("/api/categories", cookie, { method: "PUT", body: { categories: [{ name: "Food" }], currency: "usd" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { currency: string }).currency).toBe("USD");
    expect(((await (await req("/api/settings", cookie)).json()) as { currency: string }).currency).toBe("USD");
  });

  it("rejects a made-up code", async () => {
    const { cookie } = await newAccount();
    const res = await req("/api/settings", cookie, { method: "PUT", body: { currency: "ABC" } });
    expect(res.status).toBe(400);
  });

  it("budgets, totals and quick log follow the account currency; other currencies stay out", async () => {
    const { cookie, id } = await newAccount();
    await req("/api/categories", cookie, { method: "PUT", body: { categories: [{ name: "Food" }], currency: "EUR" } });
    const ctx = (r: string) => makeCtx({ userId: id, requestId: r });
    await addExpenses(ctx("a1"), [{ note: "coffee", amount: 4, category: "Food" }]);
    await addExpenses(ctx("a2"), [{ note: "coffee", amount: 4, category: "Food" }]);
    await addExpenses(ctx("a3"), [{ note: "souvenir", amount: 100, currency: "EGP", category: "Food" }]);
    const s = await budgetStatus(env.DB, id, "2026-10");
    expect(s.currency).toBe("EUR");
    expect(s.total.spent).toBe(8);
    expect(s.other_currencies).toEqual([{ currency: "EGP", total: 100 }]);
    const q = await quickItems(makeCtx({ userId: id }));
    expect(q.map((i) => [i.note, i.amount])).toEqual([["coffee", 4]]);
  });

  it("uses the currency's own large-amount limit", async () => {
    const { cookie, id } = await newAccount();
    await req("/api/categories", cookie, { method: "PUT", body: { categories: [{ name: "Food" }], currency: "USD" } });
    const small = await addExpenses(makeCtx({ userId: id, requestId: "s1" }), [{ note: "dinner", amount: 300, category: "Food" }]);
    expect(small.status).toBe("saved");
    const big = await addExpenses(makeCtx({ userId: id, requestId: "b1" }), [{ note: "dinner", amount: 3000, category: "Food" }]);
    expect(big.status).toBe("needs_confirmation");
  });

  it("changing currency relabels existing records without converting them", async () => {
    const { cookie, id } = await newAccount();
    await req("/api/categories", cookie, { method: "PUT", body: { categories: [{ name: "Food" }] } });
    await addExpenses(makeCtx({ userId: id, requestId: "r1" }), [{ note: "lunch", amount: 200, category: "Food" }]);
    await addExpenses(makeCtx({ userId: id, requestId: "r2" }), [{ note: "gift", amount: 50, currency: "USD", category: "Food" }]);
    const res = await req("/api/settings", cookie, { method: "PUT", body: { currency: "SAR" } });
    expect(((await res.json()) as { relabelled: number }).relabelled).toBe(1);
    const s = await budgetStatus(env.DB, id, "2026-10");
    expect(s.total.spent).toBe(200);
    expect(s.other_currencies).toEqual([{ currency: "USD", total: 50 }]);
  });

  it("the chat prompt and the fast path know the currency", () => {
    const p = systemPrompt("2026-10-19", [], 500, "USD");
    expect(p).toContain("Amounts are in USD");
    expect(p).toContain("amounts above 500 USD");
    expect(systemPrompt("2026-10-19", [], null, "XOF")).not.toContain("amounts above");
    expect(parseFast("coffee 200 EGP")?.items).toEqual([{ note: "coffee", amount: 200, currency: "EGP" }]);
    expect(parseFast("coffee 200")?.items).toEqual([{ note: "coffee", amount: 200 }]);
    expect(parseFast("coffee 5 dollars")).toBeNull();
  });
});

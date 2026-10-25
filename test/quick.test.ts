import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { addExpenses, quickItems } from "../src/tools/expenses";
import { makeCtx, NOW, resetDb } from "./helpers";

// D44: one-tap logging of the user's most frequent items.
beforeEach(resetDb);

const add = (note: string, amount: number, category: string, date = "2026-10-15", ts?: string) =>
  addExpenses(makeCtx(ts ? { now: new Date(ts) } : {}), [{ note, amount, category, date_token: `date:${date}` }]);

describe("quick log", () => {
  it("returns the top 5 items logged at least twice, most frequent first, with the last amount paid", async () => {
    for (const [n, note, amt, cat] of [
      [4, "coffee", 45, "food_dining"],
      [3, "uber", 90, "transport_fuel"],
      [3, "vegs", 300, "groceries"],
      [2, "gym", 500, "sports"],
      [2, "netflix", 250, "entertainment"],
      [2, "water", 20, "food_dining"],
      [1, "tv", 900, "shopping"],
    ] as const) {
      for (let i = 0; i < n; i++) await add(note, amt, cat);
    }
    await add("Coffee", 55, "food_dining", "2026-10-18", "2026-10-19T11:00:00Z"); // newest coffee, different case
    const q = await quickItems(makeCtx());
    expect(q).toHaveLength(5);
    expect(q[0]).toEqual({ note: "coffee", amount: 55, category: "food_dining", category_name: "Food & Dining", count: 5 });
    expect(q.map((i) => i.note)).not.toContain("tv");
  });

  it("ignores old, deleted and non-EGP items and categories you removed", async () => {
    await add("old thing", 10, "shopping", "2026-06-01");
    await add("old thing", 10, "shopping", "2026-06-02");
    const r1 = await add("tea", 15, "food_dining");
    await add("tea", 15, "food_dining");
    if (r1.status === "saved") await env.DB.prepare("UPDATE expenses SET deleted_at = 'x' WHERE id = ?").bind(r1.saved[0]!.id).run();
    await addExpenses(makeCtx(), [{ note: "usd lunch", amount: 10, currency: "USD", category: "food_dining" }]);
    await addExpenses(makeCtx(), [{ note: "usd lunch", amount: 10, currency: "USD", category: "food_dining" }]);
    await add("padel", 400, "sports");
    await add("padel", 400, "sports");
    await env.DB.prepare("UPDATE user_categories SET is_active = 0 WHERE user_id = 'local' AND key = 'sports'").run();
    expect(await quickItems(makeCtx())).toEqual([]);
  });

  it("is served per account at /api/quick", async () => {
    await add("coffee", 45, "food_dining");
    await add("coffee", 45, "food_dining");
    const res = await handle(new Request("http://localhost/api/quick"), env, { now: () => NOW });
    expect(await res.json()).toEqual([{ note: "coffee", amount: 45, category: "food_dining", category_name: "Food & Dining", count: 2 }]);
  });
});

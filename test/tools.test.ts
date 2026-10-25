import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import legacyData from "./fixtures/legacy.json";
import { importLegacy, type LegacyData, legacyRows } from "../src/legacy";
import { budgetStatus, ensureBudgets } from "../src/tools/budgets";
import { addExpenses, deleteExpense, undoRequest, updateExpense } from "../src/tools/expenses";
import { callTool } from "../src/tools/registry";
import type { ExpenseRow } from "../src/tools/types";
import { cairo, makeCtx, resetDb, TEST_USER } from "./helpers";

beforeEach(resetDb);

const activeRows = async () =>
  (await env.DB.prepare("SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY request_id, line_index").all<ExpenseRow>())
    .results;

async function setBudgets(month: string, amounts: Record<string, number | null>) {
  for (const [cat, amount] of Object.entries(amounts)) {
    const r = await callTool(makeCtx(), "set_budget", { category: cat, amount, month, apply_forward: false });
    expect(r.ok).toBe(true);
  }
}

describe("add_expense", () => {
  it("saves multiple items with today's Cairo date supplied by code", async () => {
    const ctx = makeCtx({ source: "chat" });
    const r = await callTool(ctx, "add_expense", {
      items: [
        { amount: 200, category: "food_dining", note: "coffee" },
        { amount: 400, category: "groceries", note: "vegs" },
      ],
    });
    expect(r.ok).toBe(true);
    const res = (r as { result: { status: string; saved: ExpenseRow[]; status_lines: string[] } }).result;
    expect(res.status).toBe("saved");
    expect(res.saved.map((s) => [s.note, s.amount, s.expense_date, s.line_index, s.currency, s.source])).toEqual([
      ["coffee", 200, "2026-10-19", 0, "EGP", "chat"],
      ["vegs", 400, "2026-10-19", 1, "EGP", "chat"],
    ]);
    expect(res.status_lines[0]).toBe("Added coffee 200. Food & Dining: 200 spent this month (no budget set).");
  });

  it("uses the Cairo date, not the UTC date, just after midnight", async () => {
    const ctx = makeCtx({ now: cairo("2026-10-20T00:01", 3) }); // still Oct 19 in UTC
    const r = await addExpenses(ctx, [{ amount: 50, category: "food_dining", note: "late snack" }]);
    expect(r.status === "saved" && r.saved[0]!.expense_date).toBe("2026-10-20");
    const ctx2 = makeCtx({ now: cairo("2026-10-19T23:59", 3) });
    const r2 = await addExpenses(ctx2, [{ amount: 50, category: "food_dining", note: "late snack" }]);
    expect(r2.status === "saved" && r2.saved[0]!.expense_date).toBe("2026-10-19");
  });

  it("resolves relative date tokens in code", async () => {
    const r = await addExpenses(makeCtx(), [
      { amount: 85, category: "transport_fuel", note: "uber", date_token: "yesterday" },
      { amount: 350, category: "sports", note: "squash court", date_token: "weekday:fri" },
    ]);
    expect(r.status === "saved" && r.saved.map((s) => s.expense_date)).toEqual(["2026-10-18", "2026-10-16"]);
    expect(r.status === "saved" && r.status_lines[0]).toContain("on 2026-10-18");
  });

  it("rejects future dates and bad tokens without writing anything", async () => {
    const r = await addExpenses(makeCtx(), [
      { amount: 10, category: "food_dining", note: "ok" },
      { amount: 10, category: "food_dining", note: "future", date_token: "date:2026-10-25" },
      { amount: 10, category: "food_dining", note: "bad", date_token: "tomorrow" },
    ]);
    expect(r.status).toBe("error");
    expect(r.status === "error" && r.errors).toHaveLength(2);
    expect(await activeRows()).toHaveLength(0);
  });

  it("asks for confirmation above the large-amount threshold, writes once confirmed", async () => {
    const ctx = makeCtx();
    const r = await callTool(ctx, "add_expense", { items: [{ amount: 15000, category: "shopping", note: "tv" }] });
    const res = (r as { result: { status: string; items: { reasons: string[] }[] } }).result;
    expect(res.status).toBe("needs_confirmation");
    expect(res.items[0]!.reasons[0]).toMatch(/above 5000/);
    expect(await activeRows()).toHaveLength(0);

    const confirmed = await addExpenses(makeCtx(), [{ amount: 15000, category: "shopping", note: "tv" }], true);
    expect(confirmed.status).toBe("saved");
    expect(await activeRows()).toHaveLength(1);
  });

  it("the threshold is exclusive: 5000 exactly saves without confirmation", async () => {
    expect((await addExpenses(makeCtx(), [{ amount: 5000, category: "bills_utilities", note: "rent share" }])).status).toBe(
      "saved",
    );
  });

  it("asks for confirmation for dates more than 60 days back", async () => {
    const r = await addExpenses(makeCtx(), [{ amount: 100, category: "food_dining", note: "old", date_token: "date:2026-08-01" }]);
    expect(r.status).toBe("needs_confirmation");
  });

  it("does not convert other currencies, and uses each currency's own large-amount limit (D45)", async () => {
    const r = await addExpenses(makeCtx(), [{ amount: 450, currency: "usd", category: "shopping", note: "laptop" }]);
    expect(r.status === "saved" && r.saved[0]!.currency).toBe("USD");
    expect(r.status === "saved" && r.status_lines[0]).toBe("Added laptop 450 USD. Shopping: 0 spent this month (no budget set).");
    const big = await addExpenses(makeCtx({ requestId: "big-usd" }), [{ amount: 9000, currency: "usd", category: "shopping", note: "laptop" }]);
    expect(big.status).toBe("needs_confirmation");
  });

  it("flags 'other' for review (D1)", async () => {
    const r = await addExpenses(makeCtx(), [{ amount: 300, category: "other", note: "gift" }]);
    expect(r.status === "saved" && r.saved[0]!.needs_review).toBe(1);
  });

  it("investments belong in 'other' and are not flagged (D1 resolved)", async () => {
    const r = await addExpenses(makeCtx(), [
      { amount: 3000, category: "other", note: "thndr index fund" },
      { amount: 2000, category: "other", note: "gold" },
      { amount: 1500, category: "other", note: "bitcoin on binance" },
      { amount: 200, category: "other", note: "random thing" },
    ]);
    expect(r.status === "saved" && r.saved.map((s) => s.needs_review)).toEqual([0, 0, 0, 1]);
  });

  it("editing a flagged 'other' note into an investment clears the flag", async () => {
    const r = await addExpenses(makeCtx(), [{ amount: 500, category: "other", note: "misc" }]);
    const id = r.status === "saved" ? r.saved[0]!.id : "";
    const u = await updateExpense(makeCtx(), id, { note: "thndr" });
    expect(u.updated.needs_review).toBe(0);
  });

  it("is idempotent: retrying the same request_id never double-writes (N4)", async () => {
    const items = [
      { amount: 200, category: "food_dining" as const, note: "coffee" },
      { amount: 400, category: "groceries" as const, note: "vegs" },
    ];
    const a = await addExpenses(makeCtx({ requestId: "same" }), items);
    const b = await addExpenses(makeCtx({ requestId: "same" }), items);
    expect(await activeRows()).toHaveLength(2);
    expect(a.status === "saved" && a.saved.map((s) => s.id)).toEqual(b.status === "saved" && b.saved.map((s) => s.id));
  });

  it("continues line_index across several calls in one request", async () => {
    const ctx = makeCtx();
    await addExpenses(ctx, [{ amount: 1, category: "food_dining", note: "a" }]);
    await addExpenses(ctx, [{ amount: 2, category: "food_dining", note: "b" }]);
    expect((await activeRows()).map((r) => r.line_index)).toEqual([0, 1]);
  });

  it.each([
    [{ items: [] }],
    [{ items: [{ amount: 0, category: "food_dining", note: "free" }] }],
    [{ items: [{ amount: -5, category: "food_dining", note: "neg" }] }],
    [{ items: [{ amount: 10, category: "pets", note: "cat food" }] }],
    [{ items: [{ amount: 10, category: "food_dining", note: "  " }] }],
    [{ items: [{ amount: "200", category: "food_dining", note: "coffee" }] }],
    [{}],
  ])("rejects invalid input %j", async (args) => {
    const r = await callTool(makeCtx(), "add_expense", args);
    // Schema problems fail validation; an unknown category comes back as a readable error listing the valid ones.
    expect(!r.ok || (r.result as { status: string }).status === "error").toBe(true);
    expect(await activeRows()).toHaveLength(0);
  });

  it("status line reports budget use (plan 10.4)", async () => {
    await setBudgets("2026-10", { food_dining: 500 });
    const r = await addExpenses(makeCtx(), [{ amount: 200, category: "food_dining", note: "coffee" }]);
    expect(r.status === "saved" && r.status_lines[0]).toBe("Added coffee 200. Food & Dining: 200 of 500 used (40%).");
    const r2 = await addExpenses(makeCtx(), [{ amount: 400, category: "food_dining", note: "dinner" }]);
    expect(r2.status === "saved" && r2.status_lines[0]).toBe("Added dinner 400. Food & Dining: 600 of 500 used (120%), over by 100.");
  });
});

describe("list / update / delete / undo", () => {
  it("lists with inclusive dates and category filter, newest first", async () => {
    await addExpenses(makeCtx(), [
      { amount: 1, category: "food_dining", note: "a", date_token: "date:2026-10-01" },
      { amount: 2, category: "groceries", note: "b", date_token: "date:2026-10-10" },
      { amount: 3, category: "food_dining", note: "c", date_token: "date:2026-10-19" },
    ]);
    const all = await callTool(makeCtx(), "list_expenses", { start_date: "2026-10-01", end_date: "2026-10-19" });
    expect((all as { result: { expenses: ExpenseRow[] } }).result.expenses.map((e) => e.note)).toEqual(["c", "b", "a"]);
    const food = await callTool(makeCtx(), "list_expenses", { start_date: "2026-10-02", end_date: "2026-10-19", category: "food_dining" });
    expect((food as { result: { expenses: ExpenseRow[] } }).result.expenses.map((e) => e.note)).toEqual(["c"]);
  });

  it("updates fields and recomputes needs_review", async () => {
    const r = await addExpenses(makeCtx(), [{ amount: 300, category: "other", note: "thing" }]);
    const id = r.status === "saved" ? r.saved[0]!.id : "";
    const u = await updateExpense(makeCtx(), id, { category: "shopping", amount: 350, date_token: "yesterday" });
    expect(u.updated).toMatchObject({ category: "shopping", amount: 350, needs_review: 0, expense_date: "2026-10-18" });
    expect(u.before.amount).toBe(300);
  });

  it("update rejects unknown ids, empty updates and future dates", async () => {
    expect((await callTool(makeCtx(), "update_expense", { id: "nope", fields: { amount: 5 } })).ok).toBe(false);
    const r = await addExpenses(makeCtx(), [{ amount: 5, category: "food_dining", note: "x" }]);
    const id = r.status === "saved" ? r.saved[0]!.id : "";
    expect((await callTool(makeCtx(), "update_expense", { id, fields: {} })).ok).toBe(false);
    expect((await callTool(makeCtx(), "update_expense", { id, fields: { date_token: "date:2027-01-01" } })).ok).toBe(false);
  });

  it("soft-deletes", async () => {
    const r = await addExpenses(makeCtx(), [{ amount: 5, category: "food_dining", note: "x" }]);
    const id = r.status === "saved" ? r.saved[0]!.id : "";
    await deleteExpense(makeCtx(), id);
    expect(await activeRows()).toHaveLength(0);
    const raw = await env.DB.prepare("SELECT deleted_at FROM expenses WHERE id = ?").bind(id).first<{ deleted_at: string }>();
    expect(raw?.deleted_at).toBeTruthy();
    expect((await callTool(makeCtx(), "delete_expense", { id })).ok).toBe(false);
  });

  it("undo removes a whole request, and undoing again restores it", async () => {
    await addExpenses(makeCtx({ requestId: "keep" }), [{ amount: 1, category: "food_dining", note: "keep" }]);
    await addExpenses(makeCtx({ requestId: "r1" }), [
      { amount: 200, category: "food_dining", note: "coffee" },
      { amount: 400, category: "groceries", note: "vegs" },
    ]);
    const u1 = await undoRequest(makeCtx(), "r1");
    expect(u1).toMatchObject({ action: "removed", count: 2 });
    expect((await activeRows()).map((r) => r.note)).toEqual(["keep"]);
    const u2 = await undoRequest(makeCtx(), "r1");
    expect(u2).toMatchObject({ action: "restored", count: 2 });
    expect(await activeRows()).toHaveLength(3);
  });

  it("undo without request_id targets the most recent request", async () => {
    await addExpenses(makeCtx({ requestId: "older", now: cairo("2026-10-19T10:00", 3) }), [
      { amount: 1, category: "food_dining", note: "older" },
    ]);
    await addExpenses(makeCtx({ requestId: "newer", now: cairo("2026-10-19T11:00", 3) }), [
      { amount: 2, category: "food_dining", note: "newer" },
    ]);
    const r = await callTool(makeCtx(), "undo_request", {});
    expect((r as { result: { request_id: string } }).result.request_id).toBe("newer");
    expect((await activeRows()).map((x) => x.note)).toEqual(["older"]);
  });

  it("undo of an unknown request is an error", async () => {
    expect((await callTool(makeCtx(), "undo_request", { request_id: "ghost" })).ok).toBe(false);
  });
});

describe("budgets", () => {
  it("copy-forward fills a new month from the latest earlier month", async () => {
    await setBudgets("2026-10", { groceries: 6000 });
    await ensureBudgets(env.DB, TEST_USER, "2026-12");
    const dec = await budgetStatus(env.DB, TEST_USER, "2026-12");
    expect(dec.rows.find((r) => r.category === "groceries")!.budget).toBe(6000);
    expect(dec.rows.find((r) => r.category === "other")!.budget).toBe(10000);
  });

  it("never copies backwards: months before the first budget month are untracked", async () => {
    const aug = await budgetStatus(env.DB, TEST_USER, "2026-08");
    expect(aug.rows.every((r) => r.budget === null)).toBe(true);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM budgets WHERE month = '2026-08'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("set_budget applies forward to later existing months but never to earlier ones (D4)", async () => {
    await ensureBudgets(env.DB, TEST_USER, "2026-11");
    await ensureBudgets(env.DB, TEST_USER, "2026-12");
    const r = await callTool(makeCtx(), "set_budget", { category: "groceries", amount: 7000, month: "2026-11" });
    expect((r as { result: { later_months_updated: number } }).result.later_months_updated).toBe(1);
    const b = async (m: string) =>
      (await budgetStatus(env.DB, TEST_USER, m)).rows.find((x) => x.category === "groceries")!.budget;
    expect(await b("2026-10")).toBeNull();
    expect(await b("2026-11")).toBe(7000);
    expect(await b("2026-12")).toBe(7000);

    await callTool(makeCtx(), "set_budget", { category: "groceries", amount: 5000, month: "2026-12", apply_forward: false });
    expect(await b("2026-11")).toBe(7000);
    expect(await b("2026-12")).toBe(5000);
  });

  it("budget table: remaining, previous month, % used, null budgets, TOTAL from rows (plan 10.1, D10)", async () => {
    await setBudgets("2026-10", { food_dining: 500, groceries: 1000 });
    await addExpenses(makeCtx(), [
      { amount: 600, category: "food_dining", note: "dinner" },
      { amount: 250, category: "groceries", note: "vegs" },
      { amount: 700, category: "shopping", note: "shoes" },
    ]);
    await addExpenses(makeCtx(), [{ amount: 300, category: "food_dining", note: "sept lunch", date_token: "date:2026-09-30" }]);

    const s = await budgetStatus(env.DB, TEST_USER, "2026-10");
    const food = s.rows.find((r) => r.category === "food_dining")!;
    expect(food).toMatchObject({ budget: 500, spent: 600, remaining: -100, prev_spent: 300, pct_used: 120 });
    const shopping = s.rows.find((r) => r.category === "shopping")!;
    expect(shopping).toMatchObject({ budget: null, spent: 700, remaining: null, pct_used: null });
    // Budgeted: food 500 + groceries 1000 + other 10000.
    expect(s.total).toEqual({
      budget: 11500,
      spent: 1550,
      budgeted_spent: 850,
      unbudgeted_spent: 700,
      remaining: 10650,
      prev_spent: 300,
      pct_used: 7.4,
    });
    expect(s.total.spent).toBe(s.rows.reduce((sum, r) => sum + r.spent, 0));
    expect(s.rows.map((r) => r.category)).toEqual([
      "food_dining", "groceries", "transport_fuel", "bills_utilities", "entertainment", "shopping", "sports", "other",
    ]);
  });

  it("distinguishes 'no data' from a true zero", async () => {
    expect((await budgetStatus(env.DB, TEST_USER, "2026-09")).has_data).toBe(false);
    await addExpenses(makeCtx(), [{ amount: 5, category: "food_dining", note: "x", date_token: "date:2026-09-30" }]);
    expect((await budgetStatus(env.DB, TEST_USER, "2026-09")).has_data).toBe(true);
  });

  it("excludes deleted rows and non-EGP amounts from spent", async () => {
    const r = await addExpenses(makeCtx(), [
      { amount: 100, category: "food_dining", note: "a" },
      { amount: 50, category: "food_dining", note: "b" },
      { amount: 20, currency: "USD", category: "food_dining", note: "c" },
    ]);
    if (r.status !== "saved") throw new Error("expected saved");
    await deleteExpense(makeCtx(), r.saved[1]!.id);
    const s = await budgetStatus(env.DB, TEST_USER, "2026-10");
    expect(s.rows.find((x) => x.category === "food_dining")!.spent).toBe(100);
    expect(s.other_currencies).toEqual([{ currency: "USD", total: 20 }]);
  });
});

describe("legacy import (plan 8.1)", () => {
  it("October reconciles with the Excel total of 1,800", async () => {
    const n = await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
    expect(n).toBeGreaterThan(0);
    const oct = await budgetStatus(env.DB, TEST_USER, "2026-10");
    expect(oct.total.spent).toBe(1800);
    expect(oct.rows.find((r) => r.category === "transport_fuel")!.spent).toBe(600);
    expect(oct.rows.find((r) => r.category === "entertainment")!.spent).toBe(1200);
    expect(oct.has_data).toBe(true);
  });

  it("every month in the file reconciles with its expected total", () => {
    const data = legacyData as LegacyData;
    const rows = legacyRows(data);
    for (const [month, expected] of Object.entries(data.expected_totals)) {
      expect(rows.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0)).toBe(expected);
    }
  });

  it("refuses a file whose categories do not add up to the Excel total", () => {
    expect(() => legacyRows({ months: { "2026-09": { other: 900 } }, expected_totals: { "2026-09": 1000 } })).toThrow(
      /sum to 900/,
    );
    expect(() => legacyRows({ months: { "2026-09": { "Pets!": 1 } }, expected_totals: {} })).toThrow(/bad category key/);
  });

  it("re-import is idempotent and legacy totals add to real expenses in the same month (D9)", async () => {
    await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
    await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
    await addExpenses(makeCtx(), [{ amount: 100, category: "entertainment", note: "cinema" }]);
    const oct = await budgetStatus(env.DB, TEST_USER, "2026-10");
    expect(oct.rows.find((r) => r.category === "entertainment")!.spent).toBe(1300);
    expect(oct.total.spent).toBe(1900);
  });

  it("legacy totals never become fake transactions", async () => {
    await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
    expect(await activeRows()).toHaveLength(0);
  });
});

describe("summarize", () => {
  it("groups by category, sorted by total, with shares and legacy months fully inside the range", async () => {
    await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
    await addExpenses(makeCtx(), [
      { amount: 200, category: "food_dining", note: "coffee" },
      { amount: 400, category: "groceries", note: "vegs" },
    ]);
    const r = await callTool(makeCtx(), "summarize", { start_date: "2026-10-01", end_date: "2026-10-31" });
    const res = (r as { result: { total: number; groups: { key: string; total: number }[]; legacy_total_included: number } }).result;
    expect(res.total).toBe(2400);
    expect(res.legacy_total_included).toBe(1800);
    expect(res.groups.map((g) => [g.key, g.total])).toEqual([
      ["entertainment", 1200],
      ["transport_fuel", 600],
      ["groceries", 400],
      ["food_dining", 200],
    ]);
  });

  it("partial months exclude legacy totals; group by day is chronological", async () => {
    await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
    await addExpenses(makeCtx(), [
      { amount: 5, category: "food_dining", note: "x", date_token: "date:2026-10-18" },
      { amount: 7, category: "food_dining", note: "y", date_token: "date:2026-10-05" },
    ]);
    const r = await callTool(makeCtx(), "summarize", { start_date: "2026-10-01", end_date: "2026-10-19", group_by: "day" });
    const res = (r as { result: { total: number; groups: { key: string }[]; legacy_total_included: number } }).result;
    expect(res.legacy_total_included).toBe(0);
    expect(res.total).toBe(12);
    expect(res.groups.map((g) => g.key)).toEqual(["2026-10-05", "2026-10-18"]);
  });

  it("rejects reversed ranges", async () => {
    expect((await callTool(makeCtx(), "summarize", { start_date: "2026-10-10", end_date: "2026-10-01" })).ok).toBe(false);
  });
});

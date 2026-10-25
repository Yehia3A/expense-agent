import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import legacyData from "./fixtures/legacy.json";
import { handle } from "../src/index";
import { importLegacy, type LegacyData } from "../src/legacy";
import { budgetStatus } from "../src/tools/budgets";
import { addExpenses, deleteExpense } from "../src/tools/expenses";
import { monthlyHistory, monthlyReport } from "../src/tools/history";
import { callTool } from "../src/tools/registry";
import { makeCtx, resetDb, TEST_USER } from "./helpers";

// Clock: Monday 2026-10-19 in Cairo. October also carries the Excel legacy
// totals (transport 600 + entertainment 1,200 = 1,800).
beforeEach(async () => {
  await resetDb();
  await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
  const add = (items: Parameters<typeof addExpenses>[1]) => addExpenses(makeCtx(), items, true);
  await add([
    { amount: 200, category: "food_dining", note: "coffee", date_token: "date:2026-10-19" },
    { amount: 150, category: "food_dining", note: "Coffee", date_token: "date:2026-10-18" },
    { amount: 400, category: "groceries", note: "vegs", date_token: "date:2026-10-05" },
    { amount: 7000, category: "shopping", note: "tv", date_token: "date:2026-10-10" },
    { amount: 300, category: "food_dining", note: "dinner", date_token: "date:2026-09-30" },
    { amount: 1000, category: "groceries", note: "monthly shop", date_token: "date:2026-09-03" },
  ]);
  const gone = await add([{ amount: 999, category: "food_dining", note: "deleted", date_token: "date:2026-10-12" }]);
  if (gone.status === "saved") await deleteExpense(makeCtx(), gone.saved[0]!.id);
});

describe("monthly_report (plan 10.3)", () => {
  it("totals, change vs last month, average, highest day and projection", async () => {
    const r = await monthlyReport(makeCtx(), "2026-10");
    expect(r).toMatchObject({
      month: "2026-10",
      is_current: true,
      days_in_month: 31,
      days_elapsed: 19,
      total: 9550,
      prev_total: 1300,
      change: 8250,
      change_pct: 634.6,
      legacy_total: 1800,
      avg_per_day: 502.63,
      highest_day: { date: "2026-10-10", total: 7000 },
    });
    expect(r.projection).toEqual({ projected_total: 15582, budget: 10000, projected_pct_of_budget: 155.8 });
  });

  it("daily series covers each elapsed day, with zeros, from transactions only", async () => {
    const r = await monthlyReport(makeCtx(), "2026-10");
    expect(r.daily).toHaveLength(19);
    expect(r.daily[0]).toEqual({ date: "2026-10-01", total: 0 });
    expect(r.daily.find((d) => d.date === "2026-10-12")!.total).toBe(0); // deleted row excluded
    expect(r.daily.at(-1)).toEqual({ date: "2026-10-19", total: 200 });
    expect(r.daily.reduce((s, d) => s + d.total, 0)).toBe(r.total - r.legacy_total);
  });

  it("category breakdown sorted by total with shares; top expenses and items", async () => {
    const r = await monthlyReport(makeCtx(), "2026-10");
    expect(r.by_category.slice(0, 4).map((c) => [c.category, c.total, c.share_pct])).toEqual([
      ["shopping", 7000, 73.3],
      ["entertainment", 1200, 12.6],
      ["transport_fuel", 600, 6.3],
      ["groceries", 400, 4.2],
    ]);
    expect(r.top_expenses.map((e) => e.note)).toEqual(["tv", "vegs", "coffee", "Coffee"]);
    // Items group case-insensitively.
    expect(r.top_items_by_total.map((i) => [i.item, i.total, i.count])).toEqual([
      ["tv", 7000, 1],
      ["vegs", 400, 1],
      ["coffee", 350, 2],
    ]);
    expect(r.top_items_by_count[0]).toEqual({ item: "coffee", total: 350, count: 2 });
  });

  it("lists expenses that need review, but not investments", async () => {
    await addExpenses(makeCtx(), [
      { amount: 50, category: "other", note: "misc" },
      { amount: 3000, category: "other", note: "thndr index fund" },
    ]);
    const r = await monthlyReport(makeCtx(), "2026-10");
    expect(r.needs_review.map((e) => e.note)).toEqual(["misc"]);
  });

  it("past months: full month, no projection; no previous data means no % change", async () => {
    const r = await monthlyReport(makeCtx(), "2026-09");
    expect(r).toMatchObject({ is_current: false, days_elapsed: 30, total: 1300, prev_total: 0, change_pct: null, projection: null });
  });

  it("legacy-only months report totals without transactions", async () => {
    await importLegacy(env.DB, TEST_USER, { months: { "2026-07": { other: 500 } }, expected_totals: {} });
    const r = await monthlyReport(makeCtx(), "2026-07");
    expect(r).toMatchObject({ has_data: true, has_transactions: false, total: 500, legacy_total: 500, top_expenses: [] });
  });

  it("refuses future months", async () => {
    expect((await callTool(makeCtx(), "monthly_report", { month: "2026-11" })).ok).toBe(false);
  });
});

describe("monthly_history (plan 10.2)", () => {
  it("starts with the account: the sign-up month and the one before, newest first (D42)", async () => {
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('local', 'localuser', 'x', '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z')").run();
    const h = await monthlyHistory(makeCtx(), "2026-10");
    expect(h.joined_month).toBe("2026-10");
    expect(h.rows.map((r) => r.month)).toEqual(["2026-10", "2026-09"]);
  });

  it("an older account shows every month since it joined, never earlier empty ones", async () => {
    await env.DB.prepare("DELETE FROM expenses").run();
    await env.DB.prepare("DELETE FROM legacy_monthly_totals").run();
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('local', 'localuser', 'x', '2026-07-10T09:00:00Z', '2026-07-10T09:00:00Z')").run();
    const h = await monthlyHistory(makeCtx(), "2026-10");
    expect(h.rows.map((r) => r.month)).toEqual(["2026-10", "2026-09", "2026-08", "2026-07", "2026-06"]);
  });

  it("reaches further back only for months that have records", async () => {
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('local', 'localuser', 'x', '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z')").run();
    await importLegacy(env.DB, TEST_USER, { months: { "2026-06": { other: 500 } }, expected_totals: {} });
    const h = await monthlyHistory(makeCtx(), "2026-10");
    expect(h.rows.map((r) => r.month)).toEqual(["2026-10", "2026-09", "2026-08", "2026-07", "2026-06"]);
    expect(h.rows.at(-1)).toMatchObject({ month: "2026-06", total: 500, has_legacy: true });
  });

  it("'-' (null) for months without records, real zeros for tracked months", async () => {
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('local', 'localuser', 'x', '2026-07-10T09:00:00Z', '2026-07-10T09:00:00Z')").run();
    const h = await monthlyHistory(makeCtx(), "2026-10");
    const sep = h.rows.find((r) => r.month === "2026-09")!;
    expect(sep).toMatchObject({ has_data: true, total: 1300 });
    expect(sep.by_category.groceries).toBe(1000);
    expect(sep.by_category.sports).toBe(0);
    const aug = h.rows.find((r) => r.month === "2026-08")!;
    expect(aug).toMatchObject({ has_data: false, total: null });
    expect(Object.values(aug.by_category).every((v) => v === null)).toBe(true);
  });

  it("includes legacy totals, window totals, average and the month selector list", async () => {
    const h = await monthlyHistory(makeCtx(), "2026-10");
    const oct = h.rows[0]!;
    expect(oct).toMatchObject({ total: 9550, has_legacy: true });
    expect(oct.by_category.entertainment).toBe(1200);
    expect(h.total).toBe(10850);
    expect(h.monthly_average).toBe(5425);
    expect(h.category_totals.groceries).toBe(1400);
    expect(h.months_with_data).toEqual(["2026-10", "2026-09"]);
  });
});

describe("reconciliation: every view agrees (plan 10, M4)", () => {
  it("budget table, report and history give the same month totals", async () => {
    for (const month of ["2026-10", "2026-09"]) {
      const status = await budgetStatus(env.DB, TEST_USER, month);
      const report = await monthlyReport(makeCtx(), month);
      const history = await monthlyHistory(makeCtx(), "2026-10");
      const row = history.rows.find((r) => r.month === month)!;
      expect(report.total).toBe(status.total.spent);
      expect(row.total).toBe(status.total.spent);
      for (const r of status.rows) expect(row.by_category[r.category]).toBe(r.spent);
    }
  });

  it("imported October alone matches the Excel total of 1,800", async () => {
    await resetDb();
    await importLegacy(env.DB, TEST_USER, legacyData as LegacyData);
    expect((await monthlyReport(makeCtx(), "2026-10")).total).toBe(1800);
    expect((await monthlyHistory(makeCtx(), "2026-10")).rows[0]!.total).toBe(1800);
  });
});

describe("top_spending", () => {
  it("ranks items and categories", async () => {
    const items = await callTool(makeCtx(), "top_spending", { start_date: "2026-10-01", end_date: "2026-10-31", by: "item", limit: 2 });
    expect((items as { result: { ranked: { rank: number; key: string }[] } }).result.ranked.map((r) => [r.rank, r.key])).toEqual([
      [1, "tv"],
      [2, "vegs"],
    ]);
    const cats = await callTool(makeCtx(), "top_spending", { start_date: "2026-10-01", end_date: "2026-10-31" });
    const res = (cats as { result: { total: number; ranked: { key: string }[] } }).result;
    expect(res.total).toBe(9550);
    expect(res.ranked.map((r) => r.key)).toEqual(["shopping", "entertainment", "transport_fuel", "groceries", "food_dining"]);
  });
});

describe("report routes", () => {
  const get = (path: string) => handle(new Request(`http://localhost${path}`), env);
  it("serve the report, history and top lists", async () => {
    expect((await get("/api/report?month=2026-10")).status).toBe(200);
    expect((await get("/api/report?month=2027-01")).status).toBe(400);
    const h = (await (await get("/api/history")).json()) as { rows: unknown[] };
    expect(h.rows.map((r) => (r as { month: string }).month).slice(0, 2)).toHaveLength(2);
    expect((await get("/api/top?start_date=2026-10-01&end_date=2026-10-19&by=item")).status).toBe(200);
  });
});

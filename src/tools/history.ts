import { z } from "zod";
import { addDays, addMonths, daysBetween, isValidMonth, isValidYmd, localDate, monthOf, monthRange } from "../lib/dates";
import { budgetStatus } from "./budgets";
import { currencyOf } from "./currency";
import { userCategories } from "./categories";
import { summarizeTool } from "./reports";
import { defineTool, type ExpenseRow, today, ToolError, type ToolContext } from "./types";

// Phase 4 reports (plan 10.2, 10.3). Every number comes from SQL plus plain
// arithmetic in code (N7); the model only picks the month.

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

const MonthInput = z
  .string()
  .refine(isValidMonth, "month must be YYYY-MM")
  .optional()
  .describe("Month as YYYY-MM. Omit for the current month.");

function checkMonth(ctx: ToolContext, month: string): { current: string } {
  const current = monthOf(today(ctx));
  if (month > current) throw new ToolError(`${month} is in the future`);
  return { current };
}

export async function monthlyReport(ctx: ToolContext, month: string) {
  const { current } = checkMonth(ctx, month);
  const t = today(ctx);
  const { start, end } = monthRange(month);
  const daysInMonth = daysBetween(start, end);
  const isCurrent = month === current;
  const daysElapsed = isCurrent ? Number(t.slice(8, 10)) : daysInMonth;

  const status = await budgetStatus(ctx.db, ctx.userId, month, await currencyOf(ctx));
  const live = "user_id = ? AND deleted_at IS NULL AND currency = ? AND expense_date >= ? AND expense_date < ?";
  const args = [ctx.userId, await currencyOf(ctx), start, end];
  const [topRows, items, days, review, notes] = await ctx.db.batch<Record<string, unknown>>([
    ctx.db.prepare(`SELECT * FROM expenses WHERE ${live} ORDER BY amount DESC, expense_date DESC LIMIT 5`).bind(...args),
    ctx.db
      .prepare(`SELECT lower(trim(note)) AS item, SUM(amount) AS total, COUNT(*) AS count FROM expenses WHERE ${live} GROUP BY item`)
      .bind(...args),
    ctx.db.prepare(`SELECT expense_date AS date, SUM(amount) AS total FROM expenses WHERE ${live} GROUP BY expense_date`).bind(...args),
    ctx.db
      .prepare(
        `SELECT * FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND needs_review = 1 AND expense_date >= ? AND expense_date < ?
         ORDER BY expense_date DESC, id DESC`,
      )
      .bind(ctx.userId, start, end),
    // D47: expenses with notes, any currency, oldest first. Notes are shown only here.
    ctx.db
      .prepare(
        `SELECT id, expense_date, note, amount, currency, category, details FROM expenses
         WHERE user_id = ? AND deleted_at IS NULL AND details IS NOT NULL AND details <> '' AND expense_date >= ? AND expense_date < ?
         ORDER BY expense_date, created_at`,
      )
      .bind(ctx.userId, start, end),
  ]);

  const itemRows = (items!.results as { item: string; total: number; count: number }[]).map((r) => ({ ...r, total: round2(r.total) }));
  const byDate = new Map((days!.results as { date: string; total: number }[]).map((d) => [d.date, d.total]));
  const daily = Array.from({ length: daysElapsed }, (_, i) => {
    const date = addDays(start, i);
    return { date, total: round2(byDate.get(date) ?? 0) };
  });
  const highest = daily.reduce<{ date: string; total: number } | null>((best, d) => (d.total > (best?.total ?? 0) ? d : best), null);

  const total = status.total.spent;
  const prev = status.total.prev_spent;
  const avg = daysElapsed > 0 ? round2(total / daysElapsed) : 0;
  const projected = isCurrent ? Math.round(avg * daysInMonth) : null;

  return {
    month,
    is_current: isCurrent,
    days_in_month: daysInMonth,
    days_elapsed: daysElapsed,
    has_data: status.has_data,
    has_transactions: daily.some((d) => d.total > 0),
    legacy_total: status.legacy_total,
    total,
    prev_total: prev,
    change: round2(total - prev),
    change_pct: prev > 0 ? round1((100 * (total - prev)) / prev) : null,
    by_category: status.rows
      .map((r) => ({
        category: r.category,
        display_name: r.display_name,
        total: r.spent,
        prev_total: r.prev_spent,
        budget: r.budget,
        share_pct: total > 0 ? round1((100 * r.spent) / total) : 0,
      }))
      .sort((a, b) => b.total - a.total),
    top_expenses: topRows!.results as unknown as ExpenseRow[],
    top_items_by_total: [...itemRows].sort((a, b) => b.total - a.total || b.count - a.count).slice(0, 5),
    top_items_by_count: [...itemRows].sort((a, b) => b.count - a.count || b.total - a.total).slice(0, 5),
    daily,
    avg_per_day: avg,
    highest_day: highest,
    projection: isCurrent
      ? {
          projected_total: projected,
          budget: status.total.budget,
          projected_pct_of_budget: status.total.budget > 0 ? round1((100 * projected!) / status.total.budget) : null,
        }
      : null,
    needs_review: review!.results as unknown as ExpenseRow[],
    notes: notes!.results as unknown as Pick<ExpenseRow, "id" | "expense_date" | "note" | "amount" | "currency" | "category" | "details">[],
    other_currencies: status.other_currencies,
  };
}

export const monthlyReportTool = defineTool({
  name: "monthly_report",
  description:
    "Full report for one month: total vs last month (amount and %), category breakdown with shares, top 5 expenses, " +
    "top items by total and by frequency, daily totals, average per day, highest day, month-end projection (current month only) " +
    "expenses that need review, and expenses with notes. Quote its numbers exactly.",
  input: z.object({ month: MonthInput }),
  async run(ctx, input) {
    return monthlyReport(ctx, input.month ?? monthOf(today(ctx)));
  },
});

/**
 * Month-by-month spending for the History view. It starts when the account
 * did (D42): the sign-up month and the month before it ("the last 2 months"),
 * reaching further back only for months that actually have records (e.g.
 * imported spreadsheet totals or back-dated expenses). Newest first.
 */
export async function monthlyHistory(ctx: ToolContext, endMonth: string, maxMonths = 24) {
  checkMonth(ctx, endMonth);
  const current = monthOf(today(ctx));

  const [account, withData] = await ctx.db.batch<Record<string, unknown>>([
    ctx.db.prepare("SELECT created_at FROM users WHERE id = ?").bind(ctx.userId),
    ctx.db
      .prepare(
        `SELECT DISTINCT substr(expense_date, 1, 7) AS month FROM expenses WHERE user_id = ? AND deleted_at IS NULL
         UNION SELECT month FROM legacy_monthly_totals WHERE user_id = ? ORDER BY month DESC`,
      )
      .bind(ctx.userId, ctx.userId),
  ]);
  const createdAt = (account!.results[0] as { created_at?: string } | undefined)?.created_at;
  const joined = createdAt && !Number.isNaN(Date.parse(createdAt)) ? monthOf(localDate(new Date(createdAt), ctx.config.tz)) : current;
  const dataMonths = (withData!.results as { month: string }[]).map((r) => r.month);
  let oldest = addMonths(joined < current ? joined : current, -1);
  const firstData = dataMonths[dataMonths.length - 1];
  if (firstData && firstData < oldest) oldest = firstData;
  const limit = addMonths(endMonth, -(maxMonths - 1));
  if (oldest < limit) oldest = limit;
  if (oldest > endMonth) oldest = endMonth;
  const months: string[] = [];
  for (let m = endMonth; m >= oldest; m = addMonths(m, -1)) months.push(m);

  const from = monthRange(oldest).start;
  const to = monthRange(endMonth).end;
  const [exp, legacy] = await ctx.db.batch<Record<string, unknown>>([
    ctx.db
      .prepare(
        `SELECT substr(expense_date, 1, 7) AS month, category, SUM(amount) AS total FROM expenses
         WHERE user_id = ? AND deleted_at IS NULL AND currency = ? AND expense_date >= ? AND expense_date < ?
         GROUP BY month, category`,
      )
      .bind(ctx.userId, await currencyOf(ctx), from, to),
    ctx.db
      .prepare("SELECT month, category, amount AS total FROM legacy_monthly_totals WHERE user_id = ? AND month >= ? AND month <= ?")
      .bind(ctx.userId, oldest, endMonth),
  ]);

  const cells = new Map<string, Map<string, number>>();
  const legacyMonths = new Set<string>();
  for (const r of legacy!.results as { month: string; category: string; total: number }[]) legacyMonths.add(r.month);
  for (const r of [...exp!.results, ...legacy!.results] as { month: string; category: string; total: number }[]) {
    const m = cells.get(r.month) ?? new Map<string, number>();
    m.set(r.category, (m.get(r.category) ?? 0) + r.total);
    cells.set(r.month, m);
  }

  // Columns: the account's categories, plus removed ones (or bare keys) that have spending in the window.
  const withSpend = new Set([...cells.values()].flatMap((m) => [...m.keys()]));
  const all = await userCategories(ctx.db, ctx.userId, { includeInactive: true });
  const cols = all.filter((c) => c.is_active || withSpend.has(c.key));
  for (const key of withSpend) if (!all.some((c) => c.key === key)) cols.push({ key, name: key, sort_order: 999, is_active: 0 });
  const categories = cols.map((c) => ({ key: c.key, display_name: c.name }));

  const rows = months.map((month) => {
    const m = cells.get(month);
    // No records at all -> null cells ('-' in the UI); a tracked month shows real zeros.
    const by_category = Object.fromEntries(categories.map((c) => [c.key, m ? round2(m.get(c.key) ?? 0) : null]));
    return {
      month,
      has_data: !!m,
      has_legacy: legacyMonths.has(month),
      by_category,
      total: m ? round2([...m.values()].reduce((s, v) => s + v, 0)) : null,
    };
  });
  const tracked = rows.filter((r) => r.has_data);
  const category_totals = Object.fromEntries(
    categories.map((c) => [c.key, round2(tracked.reduce((s, r) => s + (r.by_category[c.key] ?? 0), 0))]),
  );

  return {
    end_month: endMonth,
    joined_month: joined,
    categories,
    rows,
    category_totals,
    total: round2(tracked.reduce((s, r) => s + (r.total ?? 0), 0)),
    monthly_average: tracked.length ? round2(tracked.reduce((s, r) => s + (r.total ?? 0), 0) / tracked.length) : null,
    months_with_data: dataMonths,
  };
}

export const monthlyHistoryTool = defineTool({
  name: "monthly_history",
  description:
    "Spending per category for each month since the account started (at least the last 2 months), newest first, up to end_month. " +
    "Months with no records have null values. Use it to compare months ('how does this month compare to the last few?').",
  input: z.object({
    end_month: MonthInput,
    months: z.number().int().min(1).max(36).default(24).describe("Look back at most this many months."),
  }),
  async run(ctx, input) {
    return monthlyHistory(ctx, input.end_month ?? monthOf(today(ctx)), input.months);
  },
});

const DateInput = z.string().refine(isValidYmd, "date must be YYYY-MM-DD");

export const topSpendingTool = defineTool({
  name: "top_spending",
  description:
    "Ranked spending between two dates (both inclusive), by category or by item (the note text). " +
    "Use it for 'what did I spend most on last month?' or 'top items this month'.",
  input: z.object({
    start_date: DateInput.describe("YYYY-MM-DD, inclusive"),
    end_date: DateInput.describe("YYYY-MM-DD, inclusive"),
    by: z.enum(["category", "item"]).default("category"),
    limit: z.number().int().min(1).max(50).default(5),
  }),
  async run(ctx, input) {
    const s = (await summarizeTool.run(ctx, {
      start_date: input.start_date,
      end_date: input.end_date,
      group_by: input.by === "item" ? "note" : "category",
    })) as { total: number; groups: { key: string; total: number; count: number; share_pct: number }[]; legacy_total_included: number };
    return {
      start_date: input.start_date,
      end_date: input.end_date,
      by: input.by,
      currency: await currencyOf(ctx),
      total: s.total,
      ranked: s.groups.slice(0, input.limit).map((g, i) => ({ rank: i + 1, ...g })),
      legacy_total_included: s.legacy_total_included,
    };
  },
});

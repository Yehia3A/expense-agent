import { z } from "zod";
import { addMonths, isValidMonth, monthOf, monthRange } from "../lib/dates";
import { CATEGORY_KEYS, CategoryEnum, type CategoryKey, defineTool, today, ToolError, type ToolContext } from "./types";

// Budget math (plan 10.1). Every number here comes from SQL plus plain
// arithmetic in code; the model never computes totals (N7).

export const BASE_CURRENCY = "EGP";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Copy-forward (plan 8, D4): the first time a month is accessed, copy the latest
 * earlier month's budget rows into it. Months before the earliest budget month
 * stay empty (budget = untracked) and nothing is copied backwards.
 */
export async function ensureBudgets(db: D1Database, month: string): Promise<void> {
  const has = await db.prepare("SELECT 1 FROM budgets WHERE month = ? LIMIT 1").bind(month).first();
  if (has) return;
  const prev = await db
    .prepare("SELECT MAX(month) AS month FROM budgets WHERE month < ?")
    .bind(month)
    .first<{ month: string | null }>();
  if (!prev?.month) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO budgets (category, month, amount)
       SELECT category, ?, amount FROM budgets WHERE month = ?`,
    )
    .bind(month, prev.month)
    .run();
}

export interface MonthSpend {
  byCategory: Map<string, number>;
  hasExpenses: boolean;
  hasLegacy: boolean;
  legacyTotal: number;
  otherCurrencies: { currency: string; total: number }[];
}

/** Spending per category for a month: real EGP expenses + legacy totals (D9). */
export async function monthSpend(db: D1Database, month: string): Promise<MonthSpend> {
  const { start, end } = monthRange(month);
  const [exp, legacy, other] = await db.batch<{ category: string; total: number; n?: number; currency?: string }>([
    db
      .prepare(
        `SELECT category, SUM(amount) AS total, COUNT(*) AS n FROM expenses
         WHERE deleted_at IS NULL AND currency = ? AND expense_date >= ? AND expense_date < ?
         GROUP BY category`,
      )
      .bind(BASE_CURRENCY, start, end),
    db.prepare("SELECT category, amount AS total FROM legacy_monthly_totals WHERE month = ?").bind(month),
    db
      .prepare(
        `SELECT currency, SUM(amount) AS total FROM expenses
         WHERE deleted_at IS NULL AND currency <> ? AND expense_date >= ? AND expense_date < ?
         GROUP BY currency ORDER BY currency`,
      )
      .bind(BASE_CURRENCY, start, end),
  ]);
  const byCategory = new Map<string, number>();
  for (const r of [...exp!.results, ...legacy!.results]) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.total);
  }
  return {
    byCategory,
    hasExpenses: exp!.results.length > 0 || other!.results.length > 0,
    hasLegacy: legacy!.results.length > 0,
    legacyTotal: round2(legacy!.results.reduce((s, r) => s + r.total, 0)),
    otherCurrencies: other!.results.map((r) => ({ currency: r.currency!, total: round2(r.total) })),
  };
}

export interface BudgetRow {
  category: CategoryKey;
  display_name: string;
  budget: number | null;
  spent: number;
  remaining: number | null;
  prev_spent: number;
  pct_used: number | null;
}

export interface BudgetStatus {
  month: string;
  has_data: boolean;
  rows: BudgetRow[];
  total: {
    budget: number;
    spent: number;
    budgeted_spent: number;
    unbudgeted_spent: number;
    remaining: number;
    prev_spent: number;
    pct_used: number | null;
  };
  other_currencies: { currency: string; total: number }[];
  needs_review_count: number;
  /** Part of `spent` that comes from imported Excel totals rather than transactions (D9). */
  legacy_total: number;
}

export async function budgetStatus(db: D1Database, month: string): Promise<BudgetStatus> {
  await ensureBudgets(db, month);
  const [cats, cur, prev, review] = await Promise.all([
    db
      .prepare(
        `SELECT c.key, c.display_name, b.amount AS budget
         FROM categories c LEFT JOIN budgets b ON b.category = c.key AND b.month = ?
         WHERE c.is_active = 1 ORDER BY c.sort_order`,
      )
      .bind(month)
      .all<{ key: CategoryKey; display_name: string; budget: number | null }>(),
    monthSpend(db, month),
    monthSpend(db, addMonths(month, -1)),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM expenses WHERE deleted_at IS NULL AND needs_review = 1
         AND expense_date >= ? AND expense_date < ?`,
      )
      .bind(monthRange(month).start, monthRange(month).end)
      .first<{ n: number }>(),
  ]);

  const rows: BudgetRow[] = cats.results.map((c) => {
    const spent = round2(cur.byCategory.get(c.key) ?? 0);
    const budget = c.budget;
    return {
      category: c.key,
      display_name: c.display_name,
      budget,
      spent,
      remaining: budget === null ? null : round2(budget - spent),
      prev_spent: round2(prev.byCategory.get(c.key) ?? 0),
      // Null budget = untracked: never divide by it (plan section 2).
      pct_used: budget !== null && budget > 0 ? Math.round((1000 * spent) / budget) / 10 : null,
    };
  });

  // TOTAL row is computed from the category rows so the two cannot disagree (plan 10.1, D10).
  const budgeted = rows.filter((r) => r.budget !== null);
  const totalBudget = round2(budgeted.reduce((s, r) => s + (r.budget ?? 0), 0));
  const budgetedSpent = round2(budgeted.reduce((s, r) => s + r.spent, 0));
  const spent = round2(rows.reduce((s, r) => s + r.spent, 0));
  return {
    month,
    has_data: cur.hasExpenses || cur.hasLegacy,
    rows,
    total: {
      budget: totalBudget,
      spent,
      budgeted_spent: budgetedSpent,
      unbudgeted_spent: round2(spent - budgetedSpent),
      remaining: round2(totalBudget - budgetedSpent),
      prev_spent: round2(rows.reduce((s, r) => s + r.prev_spent, 0)),
      pct_used: totalBudget > 0 ? Math.round((1000 * budgetedSpent) / totalBudget) / 10 : null,
    },
    other_currencies: cur.otherCurrencies,
    needs_review_count: review?.n ?? 0,
    legacy_total: cur.legacyTotal,
  };
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** 'Food & Dining: 200 of 500 used (40%).' (plan 10.4) */
export function statusLine(row: BudgetRow): string {
  if (row.budget === null) return `${row.display_name}: ${fmt(row.spent)} spent this month (no budget set).`;
  const pct = row.pct_used === null ? "" : ` (${row.pct_used}%)`;
  const over = row.remaining !== null && row.remaining < 0 ? `, over by ${fmt(-row.remaining)}` : "";
  return `${row.display_name}: ${fmt(row.spent)} of ${fmt(row.budget)} used${pct}${over}.`;
}

const MonthInput = z
  .string()
  .refine(isValidMonth, "month must be YYYY-MM")
  .optional()
  .describe("Month as YYYY-MM. Omit for the current month.");

export const budgetStatusTool = defineTool({
  name: "budget_status",
  description:
    "Budget table for one month: per category budget, spent, remaining, previous month spent and % used, plus a total. Use it for questions like 'how am I doing on my budget?'.",
  input: z.object({ month: MonthInput }),
  async run(ctx, input) {
    return budgetStatus(ctx.db, input.month ?? monthOf(today(ctx)));
  },
});

export const setBudgetTool = defineTool({
  name: "set_budget",
  description:
    "Set the monthly budget for a category, e.g. 'set groceries to 6000'. By default the change also applies to later months (apply_forward). Use amount null to stop tracking a category.",
  input: z.object({
    category: CategoryEnum,
    amount: z.number().min(0).max(10_000_000).nullable(),
    month: MonthInput,
    apply_forward: z.boolean().default(true).describe("Also update later months that already have budgets. Default true."),
  }),
  async run(ctx, input) {
    return setBudget(ctx, input.category, input.amount, input.month ?? monthOf(today(ctx)), input.apply_forward);
  },
});

export async function setBudget(
  ctx: ToolContext,
  category: CategoryKey,
  amount: number | null,
  month: string,
  applyForward: boolean,
) {
  if (!CATEGORY_KEYS.includes(category)) throw new ToolError(`unknown category '${category}'`);
  await ensureBudgets(ctx.db, month);
  const stmts = [
    ctx.db
      .prepare(
        `INSERT INTO budgets (category, month, amount) VALUES (?, ?, ?)
         ON CONFLICT (category, month) DO UPDATE SET amount = excluded.amount`,
      )
      .bind(category, month, amount),
  ];
  if (applyForward) {
    stmts.push(ctx.db.prepare("UPDATE budgets SET amount = ? WHERE category = ? AND month > ?").bind(amount, category, month));
  }
  const res = await ctx.db.batch(stmts);
  const status = await budgetStatus(ctx.db, month);
  const row = status.rows.find((r) => r.category === category)!;
  return {
    category,
    month,
    amount,
    later_months_updated: applyForward ? (res[1]?.meta.changes ?? 0) : 0,
    status: row,
    status_line: statusLine(row),
  };
}

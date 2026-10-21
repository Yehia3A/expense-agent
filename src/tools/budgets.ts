import { z } from "zod";
import { addMonths, isValidMonth, monthOf, monthRange } from "../lib/dates";
import { resolveCategory, userCategories } from "./categories";
import { CategoryInput, type CategoryKey, defineTool, today, type ToolContext } from "./types";

// Budget math (plan 10.1). Every number here comes from SQL plus plain
// arithmetic in code; the model never computes totals (N7).

export const BASE_CURRENCY = "EGP";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Copy-forward (plan 8, D4): the first time a month is accessed, copy the latest
 * earlier month's budget rows into it. Months before the earliest budget month
 * stay empty (budget = untracked) and nothing is copied backwards.
 */
export async function ensureBudgets(db: D1Database, userId: string, month: string): Promise<void> {
  const has = await db.prepare("SELECT 1 FROM budgets WHERE user_id = ? AND month = ? LIMIT 1").bind(userId, month).first();
  if (has) return;
  const prev = await db
    .prepare("SELECT MAX(month) AS month FROM budgets WHERE user_id = ? AND month < ?")
    .bind(userId, month)
    .first<{ month: string | null }>();
  if (!prev?.month) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO budgets (user_id, category, month, amount)
       SELECT user_id, category, ?, amount FROM budgets WHERE user_id = ? AND month = ?`,
    )
    .bind(month, userId, prev.month)
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
export async function monthSpend(db: D1Database, userId: string, month: string): Promise<MonthSpend> {
  const { start, end } = monthRange(month);
  const [exp, legacy, other] = await db.batch<{ category: string; total: number; n?: number; currency?: string }>([
    db
      .prepare(
        `SELECT category, SUM(amount) AS total, COUNT(*) AS n FROM expenses
         WHERE user_id = ? AND deleted_at IS NULL AND currency = ? AND expense_date >= ? AND expense_date < ?
         GROUP BY category`,
      )
      .bind(userId, BASE_CURRENCY, start, end),
    db.prepare("SELECT category, amount AS total FROM legacy_monthly_totals WHERE user_id = ? AND month = ?").bind(userId, month),
    db
      .prepare(
        `SELECT currency, SUM(amount) AS total FROM expenses
         WHERE user_id = ? AND deleted_at IS NULL AND currency <> ? AND expense_date >= ? AND expense_date < ?
         GROUP BY currency ORDER BY currency`,
      )
      .bind(userId, BASE_CURRENCY, start, end),
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

export async function budgetStatus(db: D1Database, userId: string, month: string): Promise<BudgetStatus> {
  await ensureBudgets(db, userId, month);
  const [cats, budgets, cur, prev, review] = await Promise.all([
    userCategories(db, userId, { includeInactive: true }),
    db
      .prepare("SELECT category, amount FROM budgets WHERE user_id = ? AND month = ?")
      .bind(userId, month)
      .all<{ category: string; amount: number | null }>(),
    monthSpend(db, userId, month),
    monthSpend(db, userId, addMonths(month, -1)),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND needs_review = 1
         AND expense_date >= ? AND expense_date < ?`,
      )
      .bind(userId, monthRange(month).start, monthRange(month).end)
      .first<{ n: number }>(),
  ]);

  // The account's categories (D41); removed ones only while they still have spending to show,
  // and any key that has spending but no category row (e.g. imported data) under its key.
  const budgetOf = new Map(budgets.results.map((b) => [b.category, b.amount]));
  const shown = cats.filter((c) => c.is_active || cur.byCategory.has(c.key) || prev.byCategory.has(c.key));
  const known = new Set(cats.map((c) => c.key));
  for (const key of new Set([...cur.byCategory.keys(), ...prev.byCategory.keys()])) {
    if (!known.has(key)) shown.push({ key, name: key, sort_order: 999, is_active: 0 });
  }
  shown.sort((a, b) => a.sort_order - b.sort_order);

  const rows: BudgetRow[] = shown.map((c) => {
    const spent = round2(cur.byCategory.get(c.key) ?? 0);
    const budget = c.is_active ? (budgetOf.get(c.key) ?? null) : null;
    return {
      category: c.key,
      display_name: c.name,
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
    return budgetStatus(ctx.db, ctx.userId, input.month ?? monthOf(today(ctx)));
  },
});

export const setBudgetTool = defineTool({
  name: "set_budget",
  description:
    "Set the monthly budget for a category, e.g. 'set groceries to 6000'. By default the change also applies to later months (apply_forward). Use amount null to stop tracking a category.",
  input: z.object({
    category: CategoryInput.describe("A category key from the list in the system prompt."),
    amount: z.number().min(0).max(10_000_000).nullable(),
    month: MonthInput,
    apply_forward: z.boolean().default(true).describe("Also update later months that already have budgets. Default true."),
  }),
  async run(ctx, input) {
    return setBudget(ctx, await resolveCategory(ctx, input.category), input.amount, input.month ?? monthOf(today(ctx)), input.apply_forward);
  },
});

export async function setBudget(
  ctx: ToolContext,
  category: CategoryKey,
  amount: number | null,
  month: string,
  applyForward: boolean,
) {
  await ensureBudgets(ctx.db, ctx.userId, month);
  const stmts = [
    ctx.db
      .prepare(
        `INSERT INTO budgets (user_id, category, month, amount) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, category, month) DO UPDATE SET amount = excluded.amount`,
      )
      .bind(ctx.userId, category, month, amount),
  ];
  if (applyForward) {
    stmts.push(ctx.db.prepare("UPDATE budgets SET amount = ? WHERE user_id = ? AND category = ? AND month > ?").bind(amount, ctx.userId, category, month));
  }
  const res = await ctx.db.batch(stmts);
  const status = await budgetStatus(ctx.db, ctx.userId, month);
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

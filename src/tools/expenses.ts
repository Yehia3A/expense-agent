import { z } from "zod";
import { addDays, checkExpenseDate, isValidYmd, monthOf, resolveDateToken } from "../lib/dates";
import { ulid } from "../lib/ulid";
import { BASE_CURRENCY, budgetStatus, type BudgetRow, statusLine } from "./budgets";
import { CategoryEnum, type CategoryKey, defineTool, type ExpenseRow, today, ToolError, type ToolContext } from "./types";

const DATE_TOKEN_HELP =
  "Relative date token, resolved by code. Omit when the user gave no date (means today). " +
  "Values: today | yesterday | day_before_yesterday | days_ago:N | weekday:fri (most recent past Friday) | " +
  "day:5 (the most recent 5th of a month) | date:YYYY-MM-DD (only if the user typed an explicit date).";

const Amount = z.number().positive().max(10_000_000);
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "3-letter currency code")
  .transform((s) => s.toUpperCase());
const Note = z.string().trim().min(1).max(200);

export const ItemInput = z.object({
  amount: Amount.describe("Amount as a positive number. Never guess: ask if the user did not give one."),
  currency: Currency.optional().describe("ISO code. Omit for EGP."),
  category: CategoryEnum,
  note: Note.describe("Short description in the user's words, e.g. 'coffee', 'vegs'."),
  date_token: z.string().max(40).optional().describe(DATE_TOKEN_HELP),
});
export type ItemInput = z.infer<typeof ItemInput>;

interface ResolvedItem {
  amount: number;
  currency: string;
  category: CategoryKey;
  note: string;
  expense_date: string;
}

const nowIso = (ctx: ToolContext) => ctx.now().toISOString();

// D1: 'other' holds what is left each month, invested in index funds, gold or
// bitcoin. Those entries are expected there; anything else filed as 'other'
// is flagged for review because it probably belongs in a real category.
const INVESTMENT_NOTE = /thndr|index fund|\bfund\b|gold|dahab|bitcoin|\bbtc\b|binance|crypto|usdt|invest|saving|ادخار|استثمار|دهب|ذهب/i;

export function needsReview(category: CategoryKey, note: string): 0 | 1 {
  return category === "other" && !INVESTMENT_NOTE.test(note) ? 1 : 0;
}

async function getRow(db: D1Database, id: string): Promise<ExpenseRow | null> {
  return db.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first<ExpenseRow>();
}

/** Budget status for each (category, month) touched, plus one human status line per saved row. */
async function feedback(ctx: ToolContext, rows: Pick<ExpenseRow, "category" | "expense_date" | "note" | "amount" | "currency">[]) {
  const months = [...new Set(rows.map((r) => monthOf(r.expense_date)))];
  const byMonth = new Map(await Promise.all(months.map(async (m) => [m, await budgetStatus(ctx.db, m)] as const)));
  const affected: (BudgetRow & { month: string })[] = [];
  const seen = new Set<string>();
  const lines = rows.map((r) => {
    const m = monthOf(r.expense_date);
    const status = byMonth.get(m)!.rows.find((b) => b.category === r.category)!;
    const key = `${m}|${r.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      affected.push({ ...status, month: m });
    }
    const cur = r.currency === BASE_CURRENCY ? "" : ` ${r.currency}`;
    const when = r.expense_date === today(ctx) ? "" : ` on ${r.expense_date}`;
    return `Added ${r.note} ${r.amount}${cur}${when}. ${statusLine(status)}`;
  });
  return { budget: affected, status_lines: lines };
}

export type AddResult =
  | { status: "saved"; request_id: string; saved: ExpenseRow[]; budget: unknown[]; status_lines: string[] }
  | { status: "needs_confirmation"; request_id: string; items: (ResolvedItem & { reasons: string[] })[]; message: string }
  | { status: "error"; errors: string[] };

/**
 * Validate, resolve dates in code, apply the confirmation rules (plan 7.3, D11)
 * and write all items atomically. Retrying the same request_id never double-writes.
 */
export async function addExpenses(ctx: ToolContext, items: ItemInput[], confirmed = false): Promise<AddResult> {
  const t = today(ctx);
  const errors: string[] = [];
  const resolved: (ResolvedItem & { reasons: string[] })[] = [];

  items.forEach((item, i) => {
    const label = `item ${i + 1} (${item.note})`;
    const d = resolveDateToken(item.date_token, t);
    if (!d.ok) return void errors.push(`${label}: ${d.error}`);
    const check = checkExpenseDate(d.date, t, ctx.config.oldDateConfirmDays);
    if (!check.ok) return void errors.push(`${label}: ${check.error}`);
    const reasons: string[] = [];
    const currency = (item.currency ?? BASE_CURRENCY).toUpperCase();
    if (currency === BASE_CURRENCY && item.amount > ctx.config.largeAmountThreshold) {
      reasons.push(`amount ${item.amount} is above ${ctx.config.largeAmountThreshold} ${BASE_CURRENCY}`);
    }
    if (check.old) reasons.push(`date ${d.date} is more than ${ctx.config.oldDateConfirmDays} days ago`);
    resolved.push({ amount: item.amount, currency, category: item.category, note: item.note, expense_date: d.date, reasons });
  });

  if (errors.length) return { status: "error", errors };

  if (!confirmed && resolved.some((r) => r.reasons.length)) {
    return {
      status: "needs_confirmation",
      request_id: ctx.requestId,
      items: resolved,
      message: "Nothing was saved. The user must confirm these items with the Confirm button.",
    };
  }

  const created = nowIso(ctx);
  const first = ctx.lineCounter.next;
  ctx.lineCounter.next += resolved.length;
  const stmts = resolved.map((r, i) =>
    ctx.db
      .prepare(
        `INSERT INTO expenses (id, amount, currency, category, expense_date, note, needs_review,
                               source, request_id, line_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id, line_index) DO NOTHING`,
      )
      .bind(
        ulid(ctx.now().getTime()),
        r.amount,
        r.currency,
        r.category,
        r.expense_date,
        r.note,
        needsReview(r.category, r.note),
        ctx.source,
        ctx.requestId,
        first + i,
        created,
      ),
  );
  await ctx.db.batch(stmts);

  const saved = (
    await ctx.db
      .prepare("SELECT * FROM expenses WHERE request_id = ? AND line_index >= ? AND line_index < ? ORDER BY line_index")
      .bind(ctx.requestId, first, first + resolved.length)
      .all<ExpenseRow>()
  ).results;
  return { status: "saved", request_id: ctx.requestId, saved, ...(await feedback(ctx, saved)) };
}

export const addExpenseTool = defineTool({
  name: "add_expense",
  description:
    "Record one or more expenses the user says they spent. Put every item from one message into a single call. " +
    "Only call this when the user clearly reports spending with an amount; never for questions or greetings.",
  input: z.object({ items: z.array(ItemInput).min(1).max(30) }),
  async run(ctx, input) {
    // The model can never confirm on the user's behalf (D11); confirmation comes from the UI.
    return addExpenses(ctx, input.items, false);
  },
});

const DateInput = z.string().refine(isValidYmd, "date must be YYYY-MM-DD");

export const listExpensesTool = defineTool({
  name: "list_expenses",
  description:
    "List saved expenses between two dates (both inclusive), newest first. Use it to find an expense id before editing or deleting.",
  input: z.object({
    start_date: DateInput.optional().describe("YYYY-MM-DD, inclusive. Default: 30 days ago."),
    end_date: DateInput.optional().describe("YYYY-MM-DD, inclusive. Default: today."),
    category: CategoryEnum.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  async run(ctx, input) {
    const t = today(ctx);
    const start = input.start_date ?? addDays(t, -30);
    const endExclusive = addDays(input.end_date ?? t, 1);
    let sql = "SELECT * FROM expenses WHERE deleted_at IS NULL AND expense_date >= ? AND expense_date < ?";
    const args: unknown[] = [start, endExclusive];
    if (input.category) {
      sql += " AND category = ?";
      args.push(input.category);
    }
    sql += " ORDER BY expense_date DESC, id DESC LIMIT ?";
    args.push(input.limit);
    const rows = (await ctx.db.prepare(sql).bind(...args).all<ExpenseRow>()).results;
    return { start_date: start, end_date: addDays(endExclusive, -1), count: rows.length, expenses: rows };
  },
});

export const recentExpenses = async (ctx: ToolContext, limit: number) =>
  (
    await ctx.db
      .prepare("SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?")
      .bind(limit)
      .all<ExpenseRow>()
  ).results;

export const UpdateFields = z
  .object({
    amount: Amount.optional(),
    currency: Currency.optional(),
    category: CategoryEnum.optional(),
    note: Note.optional(),
    date_token: z.string().max(40).optional().describe(DATE_TOKEN_HELP),
  })
  .refine((f) => Object.values(f).some((v) => v !== undefined), "no fields to update");

export async function updateExpense(ctx: ToolContext, id: string, fields: z.infer<typeof UpdateFields>) {
  const row = await getRow(ctx.db, id);
  if (!row || row.deleted_at) throw new ToolError(`expense ${id} not found`);
  const next = { ...row };
  if (fields.amount !== undefined) next.amount = fields.amount;
  if (fields.currency !== undefined) next.currency = fields.currency;
  if (fields.note !== undefined) next.note = fields.note;
  if (fields.category !== undefined) next.category = fields.category;
  if (fields.category !== undefined || fields.note !== undefined) next.needs_review = needsReview(next.category, next.note);
  if (fields.date_token !== undefined) {
    const t = today(ctx);
    const d = resolveDateToken(fields.date_token, t);
    if (!d.ok) throw new ToolError(d.error);
    const check = checkExpenseDate(d.date, t, Number.POSITIVE_INFINITY);
    if (!check.ok) throw new ToolError(check.error);
    next.expense_date = d.date;
  }
  await ctx.db
    .prepare("UPDATE expenses SET amount = ?, currency = ?, category = ?, note = ?, expense_date = ?, needs_review = ? WHERE id = ?")
    .bind(next.amount, next.currency, next.category, next.note, next.expense_date, next.needs_review, id)
    .run();
  const updated = (await getRow(ctx.db, id))!;
  return { updated, before: row, ...(await feedback(ctx, [updated])) };
}

export const updateExpenseTool = defineTool({
  name: "update_expense",
  description: "Change fields of a saved expense by id (amount, currency, category, note or date).",
  input: z.object({ id: z.string().min(1), fields: UpdateFields }),
  async run(ctx, input) {
    return updateExpense(ctx, input.id, input.fields);
  },
});

export async function deleteExpense(ctx: ToolContext, id: string) {
  const res = await ctx.db
    .prepare("UPDATE expenses SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(nowIso(ctx), id)
    .run();
  if (!res.meta.changes) throw new ToolError(`expense ${id} not found or already deleted`);
  return { deleted: id };
}

export const deleteExpenseTool = defineTool({
  name: "delete_expense",
  description: "Delete a saved expense by id (soft delete; can be undone).",
  input: z.object({ id: z.string().min(1) }),
  async run(ctx, input) {
    return deleteExpense(ctx, input.id);
  },
});

/**
 * Undo a whole request: if it still has active rows they are soft-deleted,
 * otherwise its deleted rows are restored (so undo can itself be undone).
 * Without a request_id, undoes the most recent other request that still has active rows.
 */
export async function undoRequest(ctx: ToolContext, requestId?: string) {
  let target = requestId;
  if (!target) {
    const last = await ctx.db
      .prepare(
        "SELECT request_id FROM expenses WHERE deleted_at IS NULL AND request_id <> ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .bind(ctx.requestId)
      .first<{ request_id: string }>();
    if (!last) throw new ToolError("nothing to undo");
    target = last.request_id;
  }
  const active = await ctx.db
    .prepare("UPDATE expenses SET deleted_at = ? WHERE request_id = ? AND deleted_at IS NULL")
    .bind(nowIso(ctx), target)
    .run();
  let action: "removed" | "restored" = "removed";
  let changes = active.meta.changes ?? 0;
  if (!changes) {
    const restored = await ctx.db
      .prepare("UPDATE expenses SET deleted_at = NULL WHERE request_id = ? AND deleted_at IS NOT NULL")
      .bind(target)
      .run();
    changes = restored.meta.changes ?? 0;
    action = "restored";
    if (!changes) throw new ToolError(`no expenses found for request ${target}`);
  }
  const rows = (
    await ctx.db.prepare("SELECT * FROM expenses WHERE request_id = ? ORDER BY line_index").bind(target).all<ExpenseRow>()
  ).results;
  return { request_id: target, action, count: changes, expenses: rows };
}

export const undoRequestTool = defineTool({
  name: "undo_request",
  description:
    "Undo everything saved by one earlier message. Omit request_id to undo the most recent message that saved expenses ('undo that').",
  input: z.object({ request_id: z.string().min(1).optional() }),
  async run(ctx, input) {
    return undoRequest(ctx, input.request_id);
  },
});

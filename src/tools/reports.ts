import { z } from "zod";
import { addDays, addMonths, isValidYmd, monthOf, monthStart } from "../lib/dates";
import { currencyOf } from "./currency";
import { resolveCategory } from "./categories";
import { CategoryInput, defineTool, today, ToolError } from "./types";

const DateInput = z.string().refine(isValidYmd, "date must be YYYY-MM-DD");
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Legacy months that lie entirely inside [start, endExclusive). */
function wholeMonthsIn(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  let m = monthOf(start);
  if (monthStart(m) < start) m = addMonths(m, 1);
  while (monthStart(addMonths(m, 1)) <= endExclusive) {
    out.push(m);
    m = addMonths(m, 1);
  }
  return out;
}

export const summarizeTool = defineTool({
  name: "summarize",
  description:
    "Total EGP spending between two dates (both inclusive), grouped by category, day, month or note. " +
    "Use it to answer questions like 'what did I spend most on last month?'. Report its numbers as given; do not recompute.",
  input: z.object({
    start_date: DateInput.describe("YYYY-MM-DD, inclusive"),
    end_date: DateInput.describe("YYYY-MM-DD, inclusive"),
    group_by: z.enum(["category", "day", "month", "note"]).default("category"),
    category: CategoryInput.optional().describe("Only this category (key from your list)."),
  }),
  async run(ctx, input) {
    if (input.end_date < input.start_date) throw new ToolError("end_date is before start_date");
    if (input.start_date > today(ctx)) throw new ToolError("start_date is in the future");
    const endExclusive = addDays(input.end_date, 1);
    const category = input.category ? await resolveCategory(ctx, input.category) : undefined;
    const keyExpr = {
      category: "category",
      day: "expense_date",
      month: "substr(expense_date, 1, 7)",
      note: "lower(note)",
    }[input.group_by];

    let sql = `SELECT ${keyExpr} AS key, SUM(amount) AS total, COUNT(*) AS count FROM expenses
               WHERE user_id = ? AND deleted_at IS NULL AND currency = ? AND expense_date >= ? AND expense_date < ?`;
    const args: unknown[] = [ctx.userId, await currencyOf(ctx), input.start_date, endExclusive];
    if (category) {
      sql += " AND category = ?";
      args.push(category);
    }
    sql += " GROUP BY key";
    const rows = (await ctx.db.prepare(sql).bind(...args).all<{ key: string; total: number; count: number }>()).results;

    const groups = new Map(rows.map((r) => [r.key, { key: r.key, total: r.total, count: r.count }]));

    // Legacy monthly totals (D9) can only be attributed by category or month,
    // and only for months fully inside the range.
    const legacyMonths = input.group_by === "category" || input.group_by === "month" ? wholeMonthsIn(input.start_date, endExclusive) : [];
    let legacyIncluded = 0;
    if (legacyMonths.length) {
      const ph = legacyMonths.map(() => "?").join(",");
      let lsql = `SELECT month, category, amount FROM legacy_monthly_totals WHERE user_id = ? AND month IN (${ph})`;
      const largs: unknown[] = [ctx.userId, ...legacyMonths];
      if (category) {
        lsql += " AND category = ?";
        largs.push(category);
      }
      const legacy = (await ctx.db.prepare(lsql).bind(...largs).all<{ month: string; category: string; amount: number }>()).results;
      for (const l of legacy) {
        const key = input.group_by === "category" ? l.category : l.month;
        const g = groups.get(key) ?? { key, total: 0, count: 0 };
        g.total += l.amount;
        groups.set(key, g);
        legacyIncluded += l.amount;
      }
    }

    const sorted = [...groups.values()]
      .map((g) => ({ ...g, total: round2(g.total) }))
      .sort((a, b) => (input.group_by === "day" || input.group_by === "month" ? a.key.localeCompare(b.key) : b.total - a.total));
    const total = round2(sorted.reduce((s, g) => s + g.total, 0));
    return {
      start_date: input.start_date,
      end_date: input.end_date,
      group_by: input.group_by,
      currency: await currencyOf(ctx),
      total,
      groups: sorted.map((g) => ({ ...g, share_pct: total > 0 ? Math.round((1000 * g.total) / total) / 10 : 0 })),
      legacy_total_included: round2(legacyIncluded),
    };
  },
});

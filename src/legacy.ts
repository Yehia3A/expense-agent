import { isValidMonth } from "./lib/dates";
import { CATEGORY_KEYS } from "./tools/types";

export interface LegacyData {
  months: Record<string, Record<string, number>>;
  expected_totals: Record<string, number>;
}

/**
 * Validate legacy totals and check they reconcile with the Excel totals (plan 8.1).
 * Returns the rows to insert; throws on any mismatch so a bad file never lands.
 */
export function legacyRows(data: LegacyData): { month: string; category: string; amount: number }[] {
  const rows: { month: string; category: string; amount: number }[] = [];
  for (const [month, cats] of Object.entries(data.months)) {
    if (!isValidMonth(month)) throw new Error(`bad month '${month}'`);
    for (const [category, amount] of Object.entries(cats)) {
      if (!(CATEGORY_KEYS as readonly string[]).includes(category)) throw new Error(`${month}: unknown category '${category}'`);
      if (!(typeof amount === "number" && amount >= 0)) throw new Error(`${month}/${category}: bad amount`);
      rows.push({ month, category, amount });
    }
  }
  for (const [month, expected] of Object.entries(data.expected_totals)) {
    const sum = rows.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0);
    if (Math.abs(sum - expected) > 0.005) throw new Error(`${month}: categories sum to ${sum}, Excel total is ${expected}`);
  }
  return rows;
}

/** Idempotent: re-running replaces the stored totals for the months in the file. */
export async function importLegacy(db: D1Database, data: LegacyData): Promise<number> {
  const rows = legacyRows(data);
  if (!rows.length) return 0;
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO legacy_monthly_totals (month, category, amount) VALUES (?, ?, ?)
           ON CONFLICT (month, category) DO UPDATE SET amount = excluded.amount`,
        )
        .bind(r.month, r.category, r.amount),
    ),
  );
  return rows.length;
}

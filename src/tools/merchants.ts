import type { CategoryKey, ExpenseRow } from "./types";

// Path C (plan 7.2): term -> category cache, learned from saved expenses and
// from your corrections, checked before the LLM is asked to categorize.

export function normalizeTerm(note: string): string {
  return note.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Exact term first; otherwise single words, but only if they all agree. */
export async function lookupCategory(db: D1Database, note: string): Promise<CategoryKey | null> {
  const term = normalizeTerm(note);
  const exact = await db.prepare("SELECT category FROM merchant_map WHERE term = ?").bind(term).first<{ category: CategoryKey }>();
  if (exact) return exact.category;
  const words = [...new Set(term.split(" ").filter((w) => w.length >= 3))];
  if (!words.length || words.length === 1) return null; // a one-word note would have matched exactly
  const rows = (
    await db
      .prepare(`SELECT DISTINCT category FROM merchant_map WHERE term IN (${words.map(() => "?").join(",")})`)
      .bind(...words)
      .all<{ category: CategoryKey }>()
  ).results;
  return rows.length === 1 ? rows[0]!.category : null;
}

/**
 * Remember note -> category for saved rows. Rows flagged for review are
 * skipped (the category is a guess). `correction` means the user chose the
 * category, so it replaces whatever was learned before.
 */
export function learnStatements(db: D1Database, rows: Pick<ExpenseRow, "note" | "category" | "needs_review">[], nowIso: string) {
  return rows
    .filter((r) => !r.needs_review)
    .map((r) =>
      db
        .prepare(
          `INSERT INTO merchant_map (term, category, hits, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT (term) DO UPDATE SET
             hits = CASE WHEN merchant_map.category = excluded.category THEN merchant_map.hits + 1 ELSE 1 END,
             category = excluded.category,
             updated_at = excluded.updated_at`,
        )
        .bind(normalizeTerm(r.note), r.category, nowIso),
    );
}

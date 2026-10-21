import type { CategoryKey, ExpenseRow } from "./types";

// Path C (plan 7.2): term -> category cache, checked before the LLM is asked
// to categorize. Rows with user_id '' are the shared starting vocabulary;
// each account learns its own words (from saves and corrections) on top, and
// its own words always win over the shared ones (D34).

export const SHARED = "";

export function normalizeTerm(note: string): string {
  return note.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Exact term first; otherwise single words, but only if they all agree. */
export async function lookupCategory(db: D1Database, userId: string, note: string, allowed?: Set<string>): Promise<CategoryKey | null> {
  const term = normalizeTerm(note);
  const words = [...new Set(term.split(" ").filter((w) => w.length >= 3))];
  const terms = [...new Set([term, ...words])];
  const rows = (
    await db
      .prepare(
        `SELECT user_id, term, category FROM merchant_map
         WHERE user_id IN (?, ?) AND term IN (${terms.map(() => "?").join(",")})`,
      )
      .bind(userId, SHARED, ...terms)
      .all<{ user_id: string; term: string; category: CategoryKey }>()
  ).results;
  // Per term, the user's own row beats the shared one. Shared words only count
  // for categories this account actually has (D41).
  const best = new Map<string, CategoryKey>();
  for (const r of rows) if (r.user_id === SHARED && !best.has(r.term) && (!allowed || allowed.has(r.category))) best.set(r.term, r.category);
  for (const r of rows) if (r.user_id !== SHARED && (!allowed || allowed.has(r.category))) best.set(r.term, r.category);

  const exact = best.get(term);
  if (exact) return exact;
  if (words.length < 2) return null; // a one-word note would have matched exactly
  const found = new Set(words.map((w) => best.get(w)).filter((c): c is CategoryKey => !!c));
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * Remember note -> category for this user's saved rows. Rows flagged for
 * review are skipped (the category is a guess). A different category for a
 * known term replaces it, so a manual correction always sticks.
 */
export function learnStatements(
  db: D1Database,
  userId: string,
  rows: Pick<ExpenseRow, "note" | "category" | "needs_review">[],
  nowIso: string,
) {
  return rows
    .filter((r) => !r.needs_review)
    .map((r) =>
      db
        .prepare(
          `INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (user_id, term) DO UPDATE SET
             hits = CASE WHEN merchant_map.category = excluded.category THEN merchant_map.hits + 1 ELSE 1 END,
             category = excluded.category,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, normalizeTerm(r.note), r.category, nowIso),
    );
}

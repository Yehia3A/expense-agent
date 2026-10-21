import { z } from "zod";
import { monthOf } from "../lib/dates";
import { budgetStatus, ensureBudgets } from "./budgets";
import { defineTool, today, ToolError, type ToolContext } from "./types";

// Per-account categories (D41). Each account picks suggested categories or
// writes its own names, up to MAX_CATEGORIES, each with a monthly budget.
// 'other' is always there on top of those, for anything that doesn't fit.
// Expenses store the category *key*; renaming a category keeps its key.

export const MAX_CATEGORIES = 10;
export const OTHER_KEY = "other";
export const OTHER_NAME = "Other";

export interface Preset {
  key: string;
  name: string;
  /** Examples for the LLM and for the setup screen. */
  hint: string;
}

/** Suggestions shown at setup: the categories most people use. Their keys match the shared merchant vocabulary. */
export const PRESETS: Preset[] = [
  { key: "groceries", name: "Groceries", hint: "supermarket, vegetables, fruit, meat, bread" },
  { key: "food_dining", name: "Food & Dining", hint: "restaurants, coffee, takeaway, delivery" },
  { key: "transport_fuel", name: "Transport & Fuel", hint: "Uber, taxi, metro, fuel, parking" },
  { key: "bills_utilities", name: "Bills & Utilities", hint: "electricity, water, gas, internet, phone" },
  { key: "rent_housing", name: "Rent & Housing", hint: "rent, building fees, repairs" },
  { key: "investments", name: "Investments & Savings", hint: "index funds, gold, crypto, savings" },
  { key: "shopping", name: "Shopping", hint: "clothes, shoes, electronics" },
  { key: "entertainment", name: "Entertainment", hint: "cinema, streaming, games, outings" },
  { key: "health", name: "Health", hint: "pharmacy, doctor, medicine" },
  { key: "sports", name: "Sports & Fitness", hint: "gym, squash, padel, gear" },
  { key: "education", name: "Education", hint: "courses, tuition, books" },
  { key: "travel", name: "Travel", hint: "hotels, flights, trips" },
  { key: "personal_care", name: "Personal care", hint: "haircut, salon, cosmetics" },
  { key: "kids", name: "Kids", hint: "school supplies, toys, diapers" },
  { key: "gifts", name: "Gifts & Donations", hint: "presents, charity" },
];
const presetByKey = new Map(PRESETS.map((p) => [p.key, p]));

export interface UserCategory {
  key: string;
  name: string;
  sort_order: number;
  is_active: number;
}

const OTHER: UserCategory = { key: OTHER_KEY, name: OTHER_NAME, sort_order: 1000, is_active: 1 };
export const hintFor = (key: string) => (key === OTHER_KEY ? "anything that fits nowhere else" : presetByKey.get(key)?.hint ?? "");

const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** The account's categories, 'other' last. Removed ones (still holding history) only with includeInactive. */
export async function userCategories(db: D1Database, userId: string, opts: { includeInactive?: boolean } = {}): Promise<UserCategory[]> {
  const rows = (
    await db
      .prepare(`SELECT key, name, sort_order, is_active FROM user_categories WHERE user_id = ? ${opts.includeInactive ? "" : "AND is_active = 1"} ORDER BY sort_order, name`)
      .bind(userId)
      .all<UserCategory>()
  ).results;
  const other = rows.find((r) => r.key === OTHER_KEY);
  return [...rows.filter((r) => r.key !== OTHER_KEY), other ?? OTHER];
}

/** True until the account has chosen its categories once. */
export async function needsSetup(db: D1Database, userId: string): Promise<boolean> {
  return !(await db.prepare("SELECT 1 FROM user_categories WHERE user_id = ? LIMIT 1").bind(userId).first());
}

const cache = new WeakMap<ToolContext, Promise<UserCategory[]>>();
const ctxCategories = (ctx: ToolContext) => {
  let p = cache.get(ctx);
  if (!p) cache.set(ctx, (p = userCategories(ctx.db, ctx.userId)));
  return p;
};
export const forgetCategories = (ctx: ToolContext) => cache.delete(ctx);

/** Accepts a category key or its name (any case). Throws a ToolError listing the valid ones. */
export async function resolveCategory(ctx: ToolContext, input: string): Promise<string> {
  const cats = await ctxCategories(ctx);
  const wanted = norm(input);
  const hit = cats.find((c) => c.key === input.trim() || norm(c.name) === wanted || c.key === wanted.replace(/[^a-z0-9]+/g, "_"));
  if (hit) return hit.key;
  throw new ToolError(`unknown category '${input}'. Use one of: ${cats.map((c) => `${c.name} (${c.key})`).join(", ")}`);
}

function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return ascii || `c_${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
}

export interface CategoryInputItem {
  key?: string;
  name: string;
  budget?: number | null;
}

export type SaveResult = { ok: true; categories: UserCategory[] } | { ok: false; error: string };

/**
 * Replace the account's category list (setup screen and "Edit categories").
 * Budgets are set for `month` and carried forward. A category that is left
 * out is deleted if it was never used, otherwise hidden so its history stays.
 */
export async function saveCategories(
  ctx: ToolContext,
  items: CategoryInputItem[],
  otherBudget: number | null | undefined,
  month: string = monthOf(today(ctx)),
): Promise<SaveResult> {
  const list = items.map((i) => ({ ...i, name: i.name.normalize("NFKC").trim().replace(/\s+/g, " ") })).filter((i) => i.name);
  if (list.length > MAX_CATEGORIES) return { ok: false, error: `Up to ${MAX_CATEGORIES} categories (plus Other).` };
  const seen = new Set<string>();
  for (const i of list) {
    if (i.name.length > 35) return { ok: false, error: `"${i.name.slice(0, 35)}…" is too long (35 characters at most).` };
    const n = norm(i.name);
    if (n === norm(OTHER_NAME)) return { ok: false, error: `"Other" is already included automatically.` };
    if (seen.has(n)) return { ok: false, error: `"${i.name}" is listed twice.` };
    seen.add(n);
    for (const b of [i.budget]) if (b !== null && b !== undefined && !(Number.isFinite(b) && b >= 0 && b <= 100_000_000)) return { ok: false, error: `Budget for "${i.name}" must be a positive number.` };
  }

  const existing = (
    await ctx.db.prepare("SELECT key, name, sort_order, is_active FROM user_categories WHERE user_id = ?").bind(ctx.userId).all<UserCategory>()
  ).results;
  const byKey = new Map(existing.map((c) => [c.key, c]));
  const byName = new Map(existing.map((c) => [norm(c.name), c]));
  const used = new Set<string>([OTHER_KEY]);
  const now = ctx.now().toISOString();

  const resolved = list.map((i, idx) => {
    let key =
      (i.key && byKey.has(i.key) && i.key !== OTHER_KEY ? i.key : null) ??
      byName.get(norm(i.name))?.key ??
      PRESETS.find((p) => norm(p.name) === norm(i.name) || p.key === i.key)?.key ??
      slugify(i.name);
    if (used.has(key)) {
      const base = key;
      let n = 2;
      while (used.has(`${base}_${n}`)) n++;
      key = `${base}_${n}`;
    }
    used.add(key);
    return { key, name: i.name, budget: i.budget ?? null, sort_order: idx + 1 };
  });

  const stmts: D1PreparedStatement[] = [];
  for (const r of resolved) {
    stmts.push(
      ctx.db
        .prepare(
          `INSERT INTO user_categories (user_id, key, name, sort_order, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT (user_id, key) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, is_active = 1`,
        )
        .bind(ctx.userId, r.key, r.name, r.sort_order, now),
    );
  }
  stmts.push(
    ctx.db
      .prepare(
        `INSERT INTO user_categories (user_id, key, name, sort_order, is_active, created_at) VALUES (?, 'other', ?, 1000, 1, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET is_active = 1`,
      )
      .bind(ctx.userId, OTHER_NAME, now),
  );

  // Left out: delete if never used, else hide (keeps reports and history right).
  for (const c of existing) {
    if (c.key === OTHER_KEY || used.has(c.key)) continue;
    const inUse = await ctx.db
      .prepare(
        `SELECT 1 FROM expenses WHERE user_id = ? AND category = ? AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM legacy_monthly_totals WHERE user_id = ? AND category = ? LIMIT 1`,
      )
      .bind(ctx.userId, c.key, ctx.userId, c.key)
      .first();
    if (inUse) {
      stmts.push(ctx.db.prepare("UPDATE user_categories SET is_active = 0 WHERE user_id = ? AND key = ?").bind(ctx.userId, c.key));
    } else {
      stmts.push(ctx.db.prepare("DELETE FROM user_categories WHERE user_id = ? AND key = ?").bind(ctx.userId, c.key));
    }
    // Either way it no longer has a budget from this month on.
    stmts.push(ctx.db.prepare("DELETE FROM budgets WHERE user_id = ? AND category = ? AND month >= ?").bind(ctx.userId, c.key, month));
  }
  await ctx.db.batch(stmts);

  // Budgets for this month, carried forward to later months that already exist.
  await ensureBudgets(ctx.db, ctx.userId, month);
  const budgetStmts = [...resolved.map((r) => [r.key, r.budget] as const), [OTHER_KEY, otherBudget ?? null] as const].flatMap(([key, amount]) => [
    ctx.db
      .prepare(
        `INSERT INTO budgets (user_id, category, month, amount) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, category, month) DO UPDATE SET amount = excluded.amount`,
      )
      .bind(ctx.userId, key, month, amount),
    ctx.db.prepare("UPDATE budgets SET amount = ? WHERE user_id = ? AND category = ? AND month > ?").bind(amount, ctx.userId, key, month),
  ]);
  await ctx.db.batch(budgetStmts);

  forgetCategories(ctx);
  return { ok: true, categories: await userCategories(ctx.db, ctx.userId) };
}

export const listCategoriesTool = defineTool({
  name: "list_categories",
  description: "The user's own categories (key and name) and this month's budget for each. Use the keys with the other tools.",
  input: z.object({}),
  async run(ctx) {
    const month = monthOf(today(ctx));
    const status = await budgetStatus(ctx.db, ctx.userId, month);
    const budget = new Map(status.rows.map((r) => [r.category, r.budget]));
    return { month, categories: (await userCategories(ctx.db, ctx.userId)).map((c) => ({ key: c.key, name: c.name, budget: budget.get(c.key) ?? null })) };
  },
});

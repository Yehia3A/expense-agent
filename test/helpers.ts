import { env } from "cloudflare:workers";
import { appConfig } from "../src/env";
import { LOCAL_USER } from "../src/security/auth";
import type { Source, ToolContext } from "../src/tools/types";

/** Tool-level tests act as the same "local" account that unauthenticated localhost requests get. */
export const TEST_USER = LOCAL_USER;

/** An instant given as Cairo wall-clock time, e.g. cairo("2026-10-19T23:59", 3). */
export function cairo(local: string, offsetHours: number): Date {
  const sign = offsetHours >= 0 ? "+" : "-";
  return new Date(`${local}:00${sign}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`);
}

/** Default test clock: Monday 2026-10-19, 12:00 in Cairo (UTC+3, summer time). */
export const NOW = cairo("2026-10-19T12:00", 3);

let n = 0;
export function makeCtx(opts: { now?: Date; requestId?: string; source?: Source; userId?: string } = {}): ToolContext {
  const now = opts.now ?? NOW;
  return {
    db: env.DB,
    userId: opts.userId ?? TEST_USER,
    now: () => now,
    config: appConfig(env),
    requestId: opts.requestId ?? `req-${++n}-${Math.random().toString(36).slice(2, 8)}`,
    source: opts.source ?? "api",
    lineCounter: { next: 0 },
  };
}

/** A clean slate: no expenses, logs, legacy totals or learned merchants; the local account has the 8 classic categories and October budgets with Other at a fixture 10,000. */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM expenses"),
    env.DB.prepare("DELETE FROM logs"),
    env.DB.prepare("DELETE FROM legacy_monthly_totals"),
    env.DB.prepare("DELETE FROM merchant_map"),
    env.DB.prepare("DELETE FROM rate_limits"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM api_tokens"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM budgets"),
    env.DB.prepare("DELETE FROM user_categories"),
    env.DB.prepare(
      `INSERT INTO user_categories (user_id, key, name, sort_order, created_at) VALUES
        ('local','food_dining','Food & Dining',1,'t'), ('local','groceries','Groceries',2,'t'),
        ('local','transport_fuel','Transportation & Fuel',3,'t'), ('local','bills_utilities','Bills & Utilities',4,'t'),
        ('local','entertainment','Entertainment',5,'t'), ('local','shopping','Shopping',6,'t'),
        ('local','sports','Squash and sports',7,'t'), ('local','other','Other',1000,'t')`,
    ),
    env.DB.prepare(
      `INSERT INTO budgets (user_id, category, month, amount) VALUES
        ('local','food_dining','2026-10',NULL), ('local','groceries','2026-10',NULL), ('local','transport_fuel','2026-10',NULL),
        ('local','bills_utilities','2026-10',NULL), ('local','entertainment','2026-10',NULL), ('local','shopping','2026-10',NULL),
        ('local','sports','2026-10',NULL), ('local','other','2026-10',10000)`,
    ),
  ]);
}

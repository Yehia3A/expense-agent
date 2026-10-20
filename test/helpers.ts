import { env } from "cloudflare:workers";
import { appConfig } from "../src/env";
import type { Source, ToolContext } from "../src/tools/types";

/** An instant given as Cairo wall-clock time, e.g. cairo("2026-10-19T23:59", 3). */
export function cairo(local: string, offsetHours: number): Date {
  const sign = offsetHours >= 0 ? "+" : "-";
  return new Date(`${local}:00${sign}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`);
}

/** Default test clock: Monday 2026-10-19, 12:00 in Cairo (UTC+3, summer time). */
export const NOW = cairo("2026-10-19T12:00", 3);

let n = 0;
export function makeCtx(opts: { now?: Date; requestId?: string; source?: Source } = {}): ToolContext {
  const now = opts.now ?? NOW;
  return {
    db: env.DB,
    now: () => now,
    config: appConfig(env),
    requestId: opts.requestId ?? `req-${++n}-${Math.random().toString(36).slice(2, 8)}`,
    source: opts.source ?? "api",
    lineCounter: { next: 0 },
  };
}

/** Back to the freshly migrated state: no expenses, logs or legacy totals; October budgets only. */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM expenses"),
    env.DB.prepare("DELETE FROM logs"),
    env.DB.prepare("DELETE FROM legacy_monthly_totals"),
    env.DB.prepare("DELETE FROM merchant_map"),
    env.DB.prepare("DELETE FROM budgets"),
    env.DB.prepare(
      `INSERT INTO budgets (category, month, amount) VALUES
        ('food_dining','2026-10',NULL), ('groceries','2026-10',NULL), ('transport_fuel','2026-10',NULL),
        ('bills_utilities','2026-10',NULL), ('entertainment','2026-10',NULL), ('shopping','2026-10',NULL),
        ('sports','2026-10',NULL), ('other','2026-10',12650)`,
    ),
  ]);
}

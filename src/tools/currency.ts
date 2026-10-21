import type { AppConfig } from "../env";
import type { ToolContext } from "./types";

// The account's currency (D45). Budgets, totals and quick log are in it; an
// expense in any other currency is kept as entered but left out of totals (D18).

export const DEFAULT_CURRENCY = "EGP";

/**
 * Rough "this looks like a typo" amount per currency (about 500 US dollars),
 * above which a new expense needs Confirm. EGP uses LARGE_AMOUNT_THRESHOLD.
 * Currencies not listed here skip the large-amount check.
 */
const LARGE: Record<string, number> = {
  USD: 500, EUR: 500, GBP: 400, CHF: 450, CAD: 700, AUD: 750, NZD: 850, SGD: 650, HKD: 4000,
  JPY: 75_000, CNY: 3500, KRW: 700_000, INR: 40_000, PKR: 150_000, BDT: 60_000, IDR: 8_000_000,
  MYR: 2300, PHP: 28_000, THB: 18_000, VND: 12_500_000, SAR: 2000, AED: 2000, QAR: 2000,
  KWD: 150, BHD: 190, OMR: 190, JOD: 350, LBP: 45_000_000, IQD: 650_000, TRY: 20_000,
  MAD: 5000, TND: 1500, DZD: 65_000, NGN: 750_000, KES: 65_000, ZAR: 9000, GHS: 7500,
  BRL: 2800, MXN: 9000, ARS: 500_000, COP: 2_000_000, CLP: 470_000, RUB: 45_000,
  SEK: 5000, NOK: 5000, DKK: 3500, PLN: 2000, CZK: 11_000, HUF: 180_000, ILS: 1900,
};

let known: Set<string> | null = null;
function knownCodes(): Set<string> | null {
  if (known) return known;
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency");
    if (list?.length) known = new Set(list);
  } catch {
    /* older runtime: fall back to the 3-letter check */
  }
  return known;
}

/** 'usd ' -> 'USD'; null when it isn't an ISO 4217 code. */
export function normalizeCurrency(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return null;
  const set = knownCodes();
  if (set && !set.has(c) && !(c in LARGE) && c !== DEFAULT_CURRENCY) return null;
  return c;
}

export async function accountCurrency(db: D1Database, userId: string): Promise<string> {
  const r = await db.prepare("SELECT currency FROM users WHERE id = ?").bind(userId).first<{ currency: string }>();
  return r?.currency ?? DEFAULT_CURRENCY;
}

const cache = new WeakMap<ToolContext, Promise<string>>();
/** The account's currency, read once per request. */
export function currencyOf(ctx: ToolContext): Promise<string> {
  let p = cache.get(ctx);
  if (!p) {
    p = accountCurrency(ctx.db, ctx.userId);
    cache.set(ctx, p);
  }
  return p;
}

/** Amount above which an expense in `currency` needs Confirm, or null for no check. */
export function largeAmountFor(currency: string, config: AppConfig): number | null {
  if (currency === DEFAULT_CURRENCY) return config.largeAmountThreshold;
  return LARGE[currency] ?? null;
}

/**
 * Change the account's currency. Amounts are not converted: what was recorded
 * in the old currency is relabelled, so budgets, totals and history stay
 * together (budgets and imported totals carry no currency of their own).
 */
export async function setAccountCurrency(db: D1Database, userId: string, code: unknown): Promise<{ ok: true; currency: string; relabelled: number } | { ok: false; error: string }> {
  const next = normalizeCurrency(code);
  if (!next) return { ok: false, error: "Pick a currency from the list, or type a 3-letter code like USD." };
  const prev = await accountCurrency(db, userId);
  if (prev === next) return { ok: true, currency: next, relabelled: 0 };
  const [, moved] = await db.batch([
    db.prepare("UPDATE users SET currency = ?, updated_at = ? WHERE id = ?").bind(next, new Date().toISOString(), userId),
    db.prepare("UPDATE expenses SET currency = ? WHERE user_id = ? AND currency = ?").bind(next, userId, prev),
  ]);
  return { ok: true, currency: next, relabelled: moved!.meta.changes ?? 0 };
}

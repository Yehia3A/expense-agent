// Date handling lives in code, never in the model (plan F2, 7.1).
// All dates are plain strings: YYYY-MM-DD for days, YYYY-MM for months.
// Day arithmetic runs in UTC on those strings, so it is immune to DST.

export const DEFAULT_TZ = "Africa/Cairo";

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM = /^(\d{4})-(\d{2})$/;

/** Today's calendar date in `tz` at instant `now`. */
export function localDate(now: Date, tz: string = DEFAULT_TZ): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isValidYmd(s: string): boolean {
  const m = YMD.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

export function isValidMonth(s: string): boolean {
  const m = YM.exec(s);
  return !!m && +m[2]! >= 1 && +m[2]! <= 12;
}

function toUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(ymd: string, n: number): string {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(ymd: string): number {
  return toUtc(ymd).getUTCDay();
}

export function monthOf(ymd: string): string {
  return ymd.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Half-open range [start, end) covering the month (plan 8: half-open ranges everywhere). */
export function monthRange(month: string): { start: string; end: string } {
  return { start: monthStart(month), end: monthStart(addMonths(month, 1)) };
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

export type DateResolution = { ok: true; date: string } | { ok: false; error: string };

/**
 * Resolve a relative date token produced by the model into a calendar date.
 *
 * Tokens:
 *   today | yesterday | day_before_yesterday
 *   days_ago:N        N whole days before today
 *   weekday:fri       most recent Friday strictly before today ("last Friday", "on Friday")
 *   day:5             the most recent 5th of a month, today included ("on the 5th")
 *   date:YYYY-MM-DD   an explicit date the user typed
 * A missing or empty token means today.
 */
export function resolveDateToken(token: string | undefined | null, today: string): DateResolution {
  const t = (token ?? "").trim().toLowerCase();
  if (t === "" || t === "today") return { ok: true, date: today };
  if (t === "yesterday") return { ok: true, date: addDays(today, -1) };
  if (t === "day_before_yesterday") return { ok: true, date: addDays(today, -2) };

  const [kind, rawArg = ""] = t.split(":", 2) as [string, string?];
  const arg = rawArg.trim();

  switch (kind) {
    case "days_ago": {
      if (!/^\d{1,4}$/.test(arg)) return { ok: false, error: `bad days_ago value '${arg}'` };
      return { ok: true, date: addDays(today, -Number(arg)) };
    }
    case "weekday": {
      const target = WEEKDAYS[arg];
      if (target === undefined) return { ok: false, error: `unknown weekday '${arg}'` };
      let back = (weekday(today) - target + 7) % 7;
      if (back === 0) back = 7;
      return { ok: true, date: addDays(today, -back) };
    }
    case "day": {
      if (!/^\d{1,2}$/.test(arg)) return { ok: false, error: `bad day value '${arg}'` };
      const dom = Number(arg);
      if (dom < 1 || dom > 31) return { ok: false, error: `day out of range '${arg}'` };
      // Walk back month by month until the day exists and is not in the future.
      let month = monthOf(today);
      for (let i = 0; i < 12; i++) {
        const candidate = `${month}-${String(dom).padStart(2, "0")}`;
        if (isValidYmd(candidate) && candidate <= today) return { ok: true, date: candidate };
        month = addMonths(month, -1);
      }
      return { ok: false, error: `could not resolve day ${dom}` };
    }
    case "date": {
      if (!isValidYmd(arg)) return { ok: false, error: `invalid date '${arg}'` };
      return { ok: true, date: arg };
    }
    default:
      return { ok: false, error: `unknown date token '${token}'` };
  }
}

export type DateCheck = { ok: true; old: boolean } | { ok: false; error: string };

/** Future dates are rejected; dates more than `confirmDays` back need confirmation (plan 7.1). */
export function checkExpenseDate(date: string, today: string, confirmDays: number): DateCheck {
  if (!isValidYmd(date)) return { ok: false, error: `invalid date '${date}'` };
  if (date > today) return { ok: false, error: `date ${date} is in the future (today is ${today})` };
  return { ok: true, old: daysBetween(date, today) > confirmDays };
}

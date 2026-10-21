import { OTHER_KEY, PRESETS, userCategories } from "../tools/categories";

/** Lower-case words of 3+ letters with a plural "s" dropped: "Healthy snacks" -> healthy, snack. */
const stems = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
import { lookupCategory } from "../tools/merchants";
import type { CategoryKey } from "../tools/types";

// Path A (plan 7.2): plain "item amount, item amount" messages are parsed by
// rules and categorized from the merchant cache, without calling the LLM.
// The parser is deliberately strict: anything it is not sure about returns
// null and goes to the LLM. A missed fast path costs one LLM call; a wrong
// fast path writes a wrong expense.

export interface FastItem {
  note: string;
  amount: number;
}

export interface FastParse {
  items: FastItem[];
  date_token?: "yesterday";
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const toAsciiDigits = (s: string) =>
  s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) - (d >= "۰" ? 0x6f0 : 0x660)) % 10));

const YESTERDAY_WORDS = ["yesterday", "embare7", "embareh", "embarh", "emba7", "imbare7", "امبارح", "إمبارح", "امبارحة"];
const TODAY_WORDS = ["today", "ennaharda", "el naharda", "elnaharda", "النهارده", "النهاردة", "اليوم"];

// Anything that looks like a question, a command, another date or another
// currency is the LLM's job.
const REFUSE =
  /[?؟$€£]|\b(how|what|which|when|why|who|did|does|do|is|was|are|were|spent|spend|paid|pay|budget|set|undo|redo|delete|remove|change|edit|update|total|much|many|show|list|report|last|ago|week|month|year|tomorrow|ago|day|days|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|usd|eur|gbp|dollars?|euros?|sar|aed|for me|not|no|cancel|maybe|about|around|approx|each|per|x)\b|\d+\s*(st|nd|rd|th)\b|\d{1,4}[-/]\d{1,2}/i;

const CURRENCY = String.raw`(?:egp|le|l\.e\.?|pounds?|gneh|geneh|جنيه|ج\.?م|ج)`;
const NOTE = String.raw`([\p{L}][\p{L}\p{M}'&.\- ]{0,40}?)`;
const AMOUNT = String.raw`(\d{1,7}(?:\.\d{1,2})?)\s*(k)?`;
const NOTE_FIRST = new RegExp(String.raw`^${NOTE}\s*[:=\-]?\s*${AMOUNT}\s*${CURRENCY}?$`, "iu");
const AMOUNT_FIRST = new RegExp(String.raw`^${AMOUNT}\s*${CURRENCY}?\s+(?:on\s+|for\s+)?${NOTE}$`, "iu");

const SPLIT = /\s*(?:,|،|;|\n|\+|&|\band\b|\bw\b|\s+و\s+)\s*/i;

function stripWord(text: string, words: string[]): { text: string; found: boolean } {
  let found = false;
  let out = ` ${text} `;
  for (const w of words) {
    const re = new RegExp(String.raw`(^|[\s,،])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\s,،])`, "giu");
    if (re.test(out)) {
      found = true;
      out = out.replace(re, "$1");
    }
  }
  return { text: out.trim(), found };
}

export function parseFast(message: string): FastParse | null {
  let text = toAsciiDigits(message).trim();
  if (!text || text.length > 300) return null;

  const y = stripWord(text, YESTERDAY_WORDS);
  text = y.text;
  const t = stripWord(text, TODAY_WORDS);
  text = t.text;
  if (y.found && t.found) return null;
  if (REFUSE.test(text)) return null;

  const parts = text.split(SPLIT).map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 15) return null;

  const items: FastItem[] = [];
  for (const part of parts) {
    const m = NOTE_FIRST.exec(part);
    const a = m ? null : AMOUNT_FIRST.exec(part);
    const note = (m ? m[1] : a?.[3])?.trim().replace(/\s+/g, " ");
    const num = m ? m[2] : a?.[1];
    const k = m ? m[3] : a?.[2];
    if (!note || !num) return null;
    if (note.split(" ").length > 4) return null;
    const amount = Number(num) * (k ? 1000 : 1);
    if (!(amount > 0) || amount > 10_000_000) return null;
    items.push({ note: note.toLowerCase(), amount });
  }
  return { items, ...(y.found ? { date_token: "yesterday" as const } : {}) };
}

/** Parse and categorize; null unless every item has a cached category. */
export async function fastPath(db: D1Database, userId: string, message: string) {
  const parsed = parseFast(message);
  if (!parsed) return null;
  const cats = await userCategories(db, userId);
  const allowed = new Set(cats.map((c) => c.key));
  // D43: words from the user's own (non-suggested) category names, e.g.
  // "healthy" and "snack" from "Healthy snacks". An item that shares one is
  // the AI's call, not the shared starter vocabulary's.
  const customWords = new Set(
    cats.filter((c) => c.key !== OTHER_KEY && !PRESETS.some((p) => p.key === c.key)).flatMap((c) => stems(c.name)),
  );
  const items: { note: string; amount: number; category: CategoryKey; date_token?: string }[] = [];
  for (const it of parsed.items) {
    const useShared = !stems(it.note).some((w) => customWords.has(w));
    const category = await lookupCategory(db, userId, it.note, allowed, useShared);
    if (!category) return null;
    items.push({ ...it, category, ...(parsed.date_token ? { date_token: parsed.date_token } : {}) });
  }
  return items;
}

import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the Node eval driver
import { scoreCase, summarize } from "../eval/score.mjs";

const add = {
  id: "a",
  input: "coffee 200, vegs 400",
  expect: {
    kind: "add",
    items: [
      { amount: 200, category: "food_dining", date: "2026-10-19" },
      { amount: 400, category: ["groceries", "food_dining"], date: "2026-10-19" },
    ],
  },
};
const row = (amount: number, category: string, expense_date = "2026-10-19") => ({ amount, category, expense_date, note: "x" });

describe("eval scoring", () => {
  it("a perfect multi-item answer, in any order", () => {
    const s = scoreCase(add, { saved: [row(400, "groceries"), row(200, "food_dining")], tools: [], reply: "Saved." });
    expect(s).toMatchObject({ correct: true, false_write: false, items: [2, 2] });
  });

  it("wrong category and wrong date count per field", () => {
    const s = scoreCase(add, { saved: [row(200, "shopping"), row(400, "groceries", "2026-10-18")], tools: [] });
    expect(s.correct).toBe(false);
    expect(s.fields).toEqual({ amount: [2, 2], category: [1, 2], date: [1, 2] });
  });

  it("extra rows are false writes; missing rows lower recall", () => {
    expect(scoreCase(add, { saved: [row(200, "food_dining"), row(400, "groceries"), row(5, "other")], tools: [] }).false_write).toBe(true);
    expect(scoreCase(add, { saved: [row(200, "food_dining")], tools: [] }).items).toEqual([1, 2]);
  });

  it("asking instead of saving is an unnecessary clarification", () => {
    expect(scoreCase(add, { saved: [], tools: [], reply: "How much were the vegs?" }).unnecessary_clarification).toBe(true);
  });

  it("clarify, no_write, query, set_budget, confirm", () => {
    expect(scoreCase({ id: "q", input: "coffee", expect: { kind: "clarify" } }, { saved: [], tools: [], reply: "How much?" }).correct).toBe(true);
    expect(scoreCase({ id: "q", input: "coffee", expect: { kind: "clarify" } }, { saved: [row(1, "food_dining")], tools: [], reply: "?" }).false_write).toBe(true);
    expect(scoreCase({ id: "w", input: "hi", expect: { kind: "no_write" } }, { saved: [], tools: [], reply: "Hi" }).correct).toBe(true);
    const q = { id: "r", input: "top?", expect: { kind: "query", tools: ["top_spending"] } };
    expect(scoreCase(q, { saved: [], tools: [{ name: "top_spending", ok: true }] }).correct).toBe(true);
    expect(scoreCase(q, { saved: [], tools: [{ name: "budget_status", ok: true }] }).correct).toBe(false);
    const b = { id: "b", input: "set", expect: { kind: "set_budget", category: "groceries", amount: 6000 } };
    expect(scoreCase(b, { saved: [], tools: [{ name: "set_budget", ok: true, args: { category: "groceries", amount: 6000 } }] }).correct).toBe(true);
    expect(scoreCase(b, { saved: [], tools: [{ name: "set_budget", ok: true, args: { category: "groceries", amount: 600 } }] }).correct).toBe(false);
    const c = { id: "c", input: "tv 15000", expect: { kind: "confirm", amounts: [15000] } };
    expect(scoreCase(c, { saved: [], pending: [{ amount: 15000 }], tools: [] }).correct).toBe(true);
    expect(scoreCase(c, { saved: [row(15000, "shopping")], tools: [] }).false_write).toBe(true);
  });

  it("summarize aggregates rates and latency", () => {
    const m = summarize(
      [add, { id: "w", input: "hi", expect: { kind: "no_write" } }],
      [
        { id: "a", saved: [row(200, "food_dining"), row(400, "groceries")], tools: [], latency_ms: 100, path: "fast" },
        { id: "w", saved: [row(1, "other")], tools: [], latency_ms: 300, path: "llm", usage: { prompt_tokens: 900, completion_tokens: 100 } },
      ],
    );
    expect(m).toMatchObject({ cases: 2, accuracy_pct: 50, false_write_rate_pct: 50, llm_share_pct: 50, tokens_per_100_messages: 50000 });
    expect(m.field_accuracy_pct).toEqual({ amount: 100, category: 100, date: 100 });
    expect(m.latency_ms.p50).toBe(300);
  });
});

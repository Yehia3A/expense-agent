// Runs every eval case through the real /chat pipeline inside the Workers
// runtime, with a fixed clock and a fresh database per case, and prints one
// `EVAL_CASE {json}` line per case. scripts/eval.mjs starts this, collects
// the lines and scores them (eval/score.mjs). Not part of `npm test`.
import { env } from "cloudflare:workers";
import { describe, it } from "vitest";
import seedSql from "../migrations/0005_merchant_seed.sql?raw";
import { runChat } from "../src/chat/loop";
import { addExpenses } from "../src/tools/expenses";
import type { ExpenseRow } from "../src/tools/types";
import { makeCtx, NOW, resetDb, TEST_USER } from "../test/helpers";
import data from "./cases.json";

type EvalEnv = typeof env & { EVAL_MODE?: string; EVAL_DELAY_MS?: string; EVAL_CASES?: string; EVAL_LIMIT?: string };
const e = env as EvalEnv;
const mode = e.EVAL_MODE ?? "hybrid"; // hybrid | llm | fastpath
const only = (e.EVAL_CASES ?? "").split(",").filter(Boolean);
let cases = data.cases.filter((c) => !only.length || only.includes(c.id));
if (e.EVAL_LIMIT) cases = cases.slice(0, Number(e.EVAL_LIMIT));

// In fastpath mode the LLM is never called: messages the fast path can't take
// are recorded as deferred.
const noLlm = (async () =>
  Response.json({ choices: [{ message: { content: "(deferred to LLM)" } }] })) as unknown as typeof fetch;

const sharedSeed = seedSql
  .replace("INSERT OR IGNORE INTO merchant_map (term, category, hits, updated_at)", "INSERT OR IGNORE INTO merchant_map (user_id, term, category, hits, updated_at)")
  .replace(/^(\s*)\('/gm, "$1('', '");

async function fixtures() {
  // A little history so queries have something to answer.
  await addExpenses(makeCtx({ requestId: "fixture-oct" }), [
    { amount: 200, category: "food_dining", note: "coffee", date_token: "date:2026-10-12" },
    { amount: 450, category: "groceries", note: "vegs", date_token: "date:2026-10-10" },
    { amount: 350, category: "sports", note: "squash court", date_token: "date:2026-10-09" },
  ]);
  await addExpenses(makeCtx({ requestId: "fixture-sep" }), [
    { amount: 1200, category: "groceries", note: "monthly shop", date_token: "date:2026-09-15" },
    { amount: 300, category: "food_dining", note: "dinner", date_token: "date:2026-09-20" },
  ]);
}

describe(`eval (${mode})`, () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    await resetDb();
    // The shared starting vocabulary (user_id '' since migration 0007).
    await env.DB.prepare(sharedSeed).run();
    await fixtures();
    const runEnv = { ...env, FAST_PATH: mode === "llm" ? "off" : "on", LLM_FALLBACK_MODEL: "" };
    const requestId = `eval-${c.id}-${Date.now()}`;
    const started = Date.now();
    let res: Awaited<ReturnType<typeof runChat>> | null = null;
    let crash: string | null = null;
    try {
      res = await runChat(
        runEnv,
        TEST_USER,
        { message: c.input, request_id: requestId, history: (c as { history?: { role: "user" | "assistant"; content: string }[] }).history ?? [] },
        { now: () => NOW, fetchImpl: mode === "fastpath" ? noLlm : undefined },
      );
    } catch (err) {
      crash = String(err);
    }
    const latency = Date.now() - started;
    const saved = (
      await env.DB.prepare("SELECT * FROM expenses WHERE user_id = ? AND request_id = ? AND deleted_at IS NULL ORDER BY line_index").bind(TEST_USER, requestId).all<ExpenseRow>()
    ).results;
    const log = await env.DB.prepare("SELECT tool_calls FROM logs WHERE user_id = ? AND request_id = ? ORDER BY ts DESC LIMIT 1")
      .bind(TEST_USER, requestId)
      .first<{ tool_calls: string }>();
    const obs = {
      id: c.id,
      input: c.input,
      mode,
      model: res?.model ?? null,
      path: mode === "fastpath" && res?.path === "llm" ? "deferred" : (res?.path ?? null),
      reply: res?.reply ?? null,
      error: crash ?? res?.error ?? null,
      latency_ms: latency,
      usage: res?.usage ?? null,
      saved: saved.map((s) => ({ amount: s.amount, category: s.category, expense_date: s.expense_date, note: s.note })),
      pending: res?.pending?.items.map((p) => ({ amount: p.amount, category: p.category, expense_date: p.expense_date })) ?? null,
      tools: log ? (JSON.parse(log.tool_calls) as unknown[]) : [],
    };
    console.log("EVAL_CASE " + JSON.stringify(obs));
    const delay = Number(e.EVAL_DELAY_MS ?? 0);
    if (delay > 0 && mode !== "fastpath") await new Promise((r) => setTimeout(r, delay));
  });
});

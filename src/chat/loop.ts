import { z } from "zod";
import { appConfig, type Env, rateLimits } from "../env";
import { addDays, localDate } from "../lib/dates";
import { ulid } from "../lib/ulid";
import { checkLimits } from "../security/ratelimit";
import { hintFor, userCategories } from "../tools/categories";
import { addExpenses } from "../tools/expenses";
import { callTool, toolJsonSchemas, type ToolOutcome } from "../tools/registry";
import type { ExpenseRow, ToolContext } from "../tools/types";
import { fastPath } from "./fastpath";
import { type ChatMessage, complete, LlmError, llmConfig, type Usage } from "./llm";
import { systemPrompt } from "./prompt";
import { currencyOf, largeAmountFor } from "../tools/currency";

export const MAX_ITERATIONS = 6;
export const DEADLINE_MS = 25_000;
const MAX_TOOL_RESULT_CHARS = 8_000;

export const ChatRequest = z.object({
  message: z.string().trim().min(1).max(2000),
  request_id: z.string().min(8).max(100).regex(/^[A-Za-z0-9_:-]+$/),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) }))
    .max(10)
    .default([]),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export interface PendingConfirmation {
  request_id: string;
  items: { amount: number; currency: string; category: string; note: string; date_token: string; expense_date: string; reasons: string[] }[];
}

export interface ChatResponse {
  request_id: string;
  reply: string;
  saved: ExpenseRow[];
  status_lines: string[];
  pending: PendingConfirmation | null;
  /** True when any tool changed data, so the UI should refresh its tables. */
  changed: boolean;
  model: string | null;
  /** fast = regex + merchant cache, no LLM call (plan 7.2 paths A and C). */
  path: "fast" | "llm";
  usage?: Usage;
  replayed?: boolean;
  error?: string;
}

const MUTATING = new Set(["add_expense", "update_expense", "delete_expense", "undo_request", "set_budget"]);

export interface ChatDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/**
 * One /chat request: the LLM picks tools, code runs them. Every date, total and
 * status line comes from code; the model only chooses and fills tools (plan 9).
 */
export async function runChat(env: Env, userId: string, req: ChatRequest, deps: ChatDeps = {}): Promise<ChatResponse> {
  const now = deps.now ?? (() => new Date());
  const started = Date.now();

  // D12: a retry with the same request_id replays the stored response.
  const prior = await env.DB.prepare(
    "SELECT response FROM logs WHERE user_id = ? AND request_id = ? AND response IS NOT NULL ORDER BY ts DESC LIMIT 1",
  )
    .bind(userId, req.request_id)
    .first<{ response: string }>();
  if (prior) return { ...(JSON.parse(prior.response) as ChatResponse), replayed: true };

  const config = appConfig(env);
  const ctx: ToolContext = { db: env.DB, userId, now, config, requestId: req.request_id, source: "chat", lineCounter: { next: 0 } };
  const out: ChatResponse = {
    request_id: req.request_id,
    reply: "",
    saved: [],
    status_lines: [],
    pending: null,
    changed: false,
    model: null,
    path: "llm",
  };
  const toolLog: { name: string; args: unknown; ok: boolean }[] = [];
  const results: unknown[] = [];

  // Paths A + C: a plain "item amount, ..." message whose items are all in the
  // merchant cache is saved without calling the LLM.
  const fast = env.FAST_PATH === "off" ? null : await fastPath(env.DB, userId, req.message);
  if (fast) {
    out.path = "fast";
    const r = await addExpenses(ctx, fast);
    toolLog.push({ name: "add_expense", args: { items: fast }, ok: true });
    results.push({ ok: true, result: r });
    collect(out, "add_expense", { ok: true, result: r });
    out.reply =
      r.status === "saved" ? "Saved." : r.status === "needs_confirmation" ? "That needs confirmation: press Confirm to save it." : r.errors.join("; ");
  } else {
    try {
      await runLlm(env, req, ctx, out, toolLog, results, deps.fetchImpl);
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      out.error = e.message;
      out.reply = out.saved.length
        ? "Saved, but I couldn't finish replying."
        : `Sorry, the assistant is unavailable right now (${e.message}). Nothing was saved.`;
    }
  }

  if (!out.reply) out.reply = out.saved.length ? "Saved." : "OK.";

  // Cache the response for replay unless it failed before changing anything,
  // in which case a retry should simply try again.
  const cacheable = !out.error || out.changed;
  await env.DB.prepare(
    `INSERT INTO logs (id, user_id, request_id, ts, user_text, path, model, tool_calls, results, latency_ms, error, response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ulid(),
      userId,
      req.request_id,
      new Date().toISOString(),
      req.message,
      out.path === "fast" ? "regex" : "llm",
      out.model,
      JSON.stringify(toolLog),
      JSON.stringify(results),
      Date.now() - started,
      out.error ?? null,
      cacheable ? JSON.stringify(out) : null,
    )
    .run();

  return out;
}

function collect(out: ChatResponse, name: string, outcome: ToolOutcome) {
  if (!outcome.ok) return;
  if (MUTATING.has(name)) {
    const r = outcome.result as { status?: string };
    if (name !== "add_expense" || r.status === "saved") out.changed = true;
  }
  if (name !== "add_expense") return;
  const r = outcome.result as
    | { status: "saved"; saved: ExpenseRow[]; status_lines: string[] }
    | { status: "needs_confirmation"; items: { amount: number; currency: string; category: string; note: string; expense_date: string; reasons: string[] }[] }
    | { status: "error" };
  if (r.status === "saved") {
    out.saved.push(...r.saved);
    out.status_lines.push(...r.status_lines);
  } else if (r.status === "needs_confirmation") {
    // The confirm click becomes its own request so its line_index values never
    // collide with rows this chat request already saved (D11).
    out.pending = {
      request_id: `${out.request_id}:confirm`,
      items: r.items.map((it) => ({ ...it, date_token: `date:${it.expense_date}` })),
    };
  }
}

/** Path B: the model chooses tools, code runs them, until the model replies with text. */
async function runLlm(
  env: Env,
  req: ChatRequest,
  ctx: ToolContext,
  out: ChatResponse,
  toolLog: { name: string; args: unknown; ok: boolean }[],
  results: unknown[],
  fetchImpl?: typeof fetch,
) {
  let cfg = llmConfig(env);
  const fallback = env.LLM_FALLBACK_MODEL;
  out.model = `${cfg.provider}/${cfg.model}`;
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  out.usage = usage;

  // R2: when the main model's free quota runs out, switch to the fallback for the rest of this request.
  const ask = async (messages: ChatMessage[], signal: AbortSignal) => {
    try {
      return await complete(cfg, messages, tools, { signal, fetchImpl, usage });
    } catch (e) {
      if (!(e instanceof LlmError && e.status === 429 && fallback && fallback !== cfg.model)) throw e;
      cfg = { ...cfg, model: fallback };
      out.model = `${cfg.provider}/${cfg.model}`;
      return complete(cfg, messages, tools, { signal, fetchImpl, usage });
    }
  };

  // D43: show the model what this user actually files in each category, so a
  // custom one like "Healthy snacks" pulls in protein bars and greek yogurt.
  const recent = (
    await env.DB.prepare(
      `SELECT category, lower(trim(note)) AS item, COUNT(*) AS n FROM expenses
       WHERE user_id = ? AND deleted_at IS NULL AND expense_date >= ?
       GROUP BY category, item ORDER BY n DESC, MAX(created_at) DESC LIMIT 300`,
    )
      .bind(ctx.userId, addDays(localDate(ctx.now(), ctx.config.tz), -120))
      .all<{ category: string; item: string; n: number }>()
  ).results;
  const examples = new Map<string, string[]>();
  for (const r of recent) {
    const list = examples.get(r.category) ?? [];
    if (list.length < 6 && r.item.length <= 40) list.push(r.item);
    examples.set(r.category, list);
  }
  const categories = (await userCategories(env.DB, ctx.userId)).map((c) => ({
    key: c.key,
    display_name: c.name,
    hint: hintFor(c.key),
    examples: examples.get(c.key),
  }));
  const currency = await currencyOf(ctx);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(localDate(ctx.now(), ctx.config.tz), categories, largeAmountFor(currency, ctx.config), currency) },
    ...req.history,
    { role: "user", content: req.message },
  ];
  const tools = toolJsonSchemas();
  const deadline = AbortSignal.timeout(DEADLINE_MS);

  // The free LLM quota is shared by every account: cap how many messages a day may use it.
  const quota = await checkLimits(env.DB, [{ bucket: "llm:all:day", windowSec: 86400, max: rateLimits(env).llmPerDay }], ctx.now().getTime());
  if (!quota.ok) {
    throw new LlmError("the shared AI quota for today is used up; plain messages like 'coffee 200' still work", 429);
  }

  for (let i = 0; ; i++) {
    if (i >= MAX_ITERATIONS) {
      out.reply = "Sorry, I couldn't finish that. Please try rephrasing.";
      out.error = "iteration cap reached";
      return;
    }
    const msg = await ask(messages, deadline);
    if (!msg.tool_calls.length) {
      out.reply = (msg.content ?? "").trim();
      return;
    }
    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args: unknown;
      let outcome: ToolOutcome;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        outcome = await callTool(ctx, call.function.name, args);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        args = call.function.arguments;
        outcome = { ok: false, error: "arguments were not valid JSON" };
      }
      toolLog.push({ name: call.function.name, args, ok: outcome.ok });
      results.push(outcome);
      collect(out, call.function.name, outcome);
      const content = JSON.stringify(outcome);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: content.length > MAX_TOOL_RESULT_CHARS ? content.slice(0, MAX_TOOL_RESULT_CHARS) + "…(truncated)" : content,
      });
    }
  }
}

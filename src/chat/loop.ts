import { z } from "zod";
import { appConfig, type Env, rateLimits } from "../env";
import { addDays, localDate } from "../lib/dates";
import { ulid } from "../lib/ulid";
import { checkLimits } from "../security/ratelimit";
import { hintFor, userCategories } from "../tools/categories";
import { addExpenses, recentExpenses } from "../tools/expenses";
import { callTool, toolJsonSchemas, type ToolOutcome } from "../tools/registry";
import type { ExpenseRow, ToolContext } from "../tools/types";
import { fastPath } from "./fastpath";
import { type ChatMessage, complete, LlmError, llmConfig, type Usage } from "./llm";
import { systemPrompt } from "./prompt";
import { currencyOf, largeAmountFor } from "../tools/currency";

export const MAX_ITERATIONS = 6;
export const DEADLINE_MS = 25_000;
const MAX_TOOL_RESULT_CHARS = 8_000;
/** How much of the conversation goes back to the model (oldest turns drop first). */
export const HISTORY_CHAR_BUDGET = 6_000;
/** Recent expenses (with ids) shown to the model so it can edit them directly (D48). */
export const RECENT_FOR_MODEL = 15;

export const ChatRequest = z.object({
  message: z.string().trim().min(1).max(2000),
  request_id: z.string().min(8).max(100).regex(/^[A-Za-z0-9_:-]+$/),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(100)
    .default([]),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export interface PendingConfirmation {
  request_id: string;
  items: { amount: number; currency: string; category: string; note: string; date_token: string; expense_date: string; details?: string | null; reasons: string[] }[];
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
  /** What the tools did, with ids, for the client to send back in history (D48). */
  memo?: string;
}

const MUTATING = new Set(["add_expense", "update_expense", "delete_expense", "undo_request", "set_budget"]);

export interface ChatDeps {
  now?: () => Date;
  /** The account's time zone (D46). */
  timezone?: string;
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

  const config = appConfig(env, deps.timezone);
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

/** One short line per expense: enough for the model to find and edit it. */
export function rowLine(r: Pick<ExpenseRow, "id" | "expense_date" | "amount" | "currency" | "category" | "note" | "details">): string {
  return `id=${r.id} | ${r.expense_date} | ${r.amount} ${r.currency} | ${r.category} | ${r.note}${r.details ? ` | notes: ${r.details}` : ""}`;
}

function addMemo(out: ChatResponse, line: string) {
  out.memo = out.memo ? `${out.memo}\n${line}` : line;
}

function collect(out: ChatResponse, name: string, outcome: ToolOutcome) {
  if (!outcome.ok) return;
  if (name === "update_expense") addMemo(out, `updated: ${rowLine((outcome.result as { updated: ExpenseRow }).updated)}`);
  if (name === "delete_expense") addMemo(out, `deleted: id=${(outcome.result as { deleted: string }).deleted}`);
  if (MUTATING.has(name)) {
    const r = outcome.result as { status?: string };
    if (name !== "add_expense" || r.status === "saved") out.changed = true;
  }
  if (name !== "add_expense") return;
  const r = outcome.result as
    | { status: "saved"; saved: ExpenseRow[]; status_lines: string[] }
    | { status: "needs_confirmation"; items: { amount: number; currency: string; category: string; note: string; expense_date: string; details?: string | null; reasons: string[] }[] }
    | { status: "error" };
  if (r.status === "saved") {
    for (const row of r.saved) addMemo(out, `saved: ${rowLine(row)}`);
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
  const latest = await recentExpenses(ctx, RECENT_FOR_MODEL);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(localDate(ctx.now(), ctx.config.tz), categories, largeAmountFor(currency, ctx.config), currency, ctx.config.tz) },
    {
      role: "system",
      content: latest.length
        ? `The user's ${latest.length} most recently logged expenses, newest first (id | date | amount | category | item | notes):\n${latest.map(rowLine).join("\n")}`
        : "The user has no expenses logged yet.",
    },
    ...trimHistory(req.history),
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
        args = dropNulls(call.function.arguments ? JSON.parse(call.function.arguments) : {});
        outcome = await callTool(ctx, call.function.name, args);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        args = call.function.arguments;
        outcome = { ok: false, error: "arguments were not valid JSON" };
      }
      toolLog.push({ name: call.function.name, args, ok: outcome.ok });
      results.push(outcome);
      collect(out, call.function.name, outcome);
      const content = JSON.stringify(forModel(call.function.name, outcome));
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: content.length > MAX_TOOL_RESULT_CHARS ? content.slice(0, MAX_TOOL_RESULT_CHARS) + "…(truncated)" : content,
      });
    }
  }
}

/**
 * The newest turns that fit the budget, starting with a user turn. The whole
 * visible chat is sent; only very long ones lose their oldest turns.
 */
export function trimHistory(history: ChatRequest["history"], budget = HISTORY_CHAR_BUDGET): ChatRequest["history"] {
  let used = 0;
  let start = history.length;
  while (start > 0 && used + history[start - 1]!.content.length <= budget) used += history[--start]!.content.length;
  while (start < history.length && history[start]!.role !== "user") start++;
  return history.slice(start);
}

/** Models often send null for fields they mean to leave out; treat null as absent. */
export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  }
  return v;
}

/** Tool results as the model sees them: expense lists as short lines so they aren't cut off. */
function forModel(name: string, outcome: ToolOutcome): unknown {
  if (!outcome.ok || name !== "list_expenses") return outcome;
  const r = outcome.result as { expenses: ExpenseRow[] } & Record<string, unknown>;
  return { ok: true, result: { ...r, expenses: r.expenses.map(rowLine) } };
}

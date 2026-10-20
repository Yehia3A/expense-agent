import { z } from "zod";
import { ChatRequest, runChat } from "./chat/loop";
import { appConfig, type Env } from "./env";
import { ulid } from "./lib/ulid";
import { addExpenses, ItemInput, recentExpenses } from "./tools/expenses";
import { callTool, type ToolOutcome } from "./tools/registry";
import type { ToolContext } from "./tools/types";

// Thin HTTP adapters over the tool layer (plan 6). Static UI files in
// public/ are served by Workers Static Assets for every other path.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const fail = (status: number, error: string, details?: unknown) => json({ error, details }, status);

function apiCtx(env: Env, requestId: string = ulid()): ToolContext {
  return {
    db: env.DB,
    now: () => new Date(),
    config: appConfig(env),
    requestId,
    source: "api",
    lineCounter: { next: 0 },
  };
}

/** Constant-time comparison so the token can't be guessed byte by byte from timing. */
function sameToken(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** D14: when APP_TOKEN is set, every /api and /chat call needs `Authorization: Bearer <token>`. */
function authorized(req: Request, env: Env): boolean {
  if (!env.APP_TOKEN) return true;
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return !!m && sameToken(m[1]!.trim(), env.APP_TOKEN);
}

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function fromOutcome(o: ToolOutcome): Response {
  return o.ok ? json(o.result) : fail(400, o.error, o.details);
}

/** N5: API mutations are logged like chat requests. */
async function logApi(env: Env, requestId: string, what: string, args: unknown, result: unknown, started: number, error?: string) {
  await env.DB.prepare(
    `INSERT INTO logs (id, request_id, ts, user_text, path, tool_calls, results, latency_ms, error)
     VALUES (?, ?, ?, NULL, 'api', ?, ?, ?, ?)`,
  )
    .bind(ulid(), requestId, new Date().toISOString(), JSON.stringify([{ name: what, args }]), JSON.stringify(result), Date.now() - started, error ?? null)
    .run();
}

async function mutate(env: Env, name: string, args: unknown, requestId?: string): Promise<Response> {
  const started = Date.now();
  const ctx = apiCtx(env, requestId);
  const outcome = await callTool(ctx, name, args);
  await logApi(env, ctx.requestId, name, args, outcome, started, outcome.ok ? undefined : outcome.error);
  return fromOutcome(outcome);
}

const AddRequest = z.object({
  request_id: z.string().min(8).max(100).regex(/^[A-Za-z0-9_:-]+$/),
  items: z.array(ItemInput).min(1).max(30),
  confirmed: z.boolean().default(false),
});

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const q = Object.fromEntries(url.searchParams);
  const method = req.method;

  if (path === "/api/health" && method === "GET") return json({ ok: true });

  if (path === "/api/categories" && method === "GET") {
    const rows = await env.DB.prepare("SELECT key, display_name, sort_order FROM categories WHERE is_active = 1 ORDER BY sort_order").all();
    return json(rows.results);
  }

  if (path === "/api/expenses/recent" && method === "GET") {
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 200);
    return json(await recentExpenses(apiCtx(env), limit));
  }

  if (path === "/api/expenses" && method === "GET") {
    return fromOutcome(
      await callTool(apiCtx(env), "list_expenses", {
        start_date: q.start_date,
        end_date: q.end_date,
        category: q.category,
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    );
  }

  // Manual add and the Confirm button (D11). Idempotent on request_id.
  if (path === "/api/expenses" && method === "POST") {
    const started = Date.now();
    const parsed = AddRequest.safeParse(await body(req));
    if (!parsed.success) return fail(400, "invalid request", z.treeifyError(parsed.error));
    const ctx = apiCtx(env, parsed.data.request_id);
    const result = await addExpenses(ctx, parsed.data.items, parsed.data.confirmed);
    await logApi(env, ctx.requestId, "add_expense", parsed.data, result, started, result.status === "error" ? result.errors.join("; ") : undefined);
    return json(result, result.status === "error" ? 400 : 200);
  }

  const idMatch = /^\/api\/expenses\/([A-Za-z0-9]+)$/.exec(path);
  if (idMatch && method === "PATCH") {
    const b = (await body(req)) as { fields?: unknown } | undefined;
    return mutate(env, "update_expense", { id: idMatch[1], fields: b?.fields ?? b });
  }
  if (idMatch && method === "DELETE") return mutate(env, "delete_expense", { id: idMatch[1] });

  if (path === "/api/undo" && method === "POST") {
    const b = (await body(req)) as { request_id?: string } | undefined;
    return mutate(env, "undo_request", { request_id: b?.request_id });
  }

  if (path === "/api/budget-status" && method === "GET") {
    return fromOutcome(await callTool(apiCtx(env), "budget_status", { month: q.month || undefined }));
  }

  if (path === "/api/budgets" && method === "PUT") return mutate(env, "set_budget", await body(req));

  return fail(404, "not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isApi = url.pathname === "/chat" || url.pathname.startsWith("/api/");
    if (!isApi) return env.ASSETS.fetch(req);

    if (!authorized(req, env)) return fail(401, "unauthorized");

    try {
      if (url.pathname === "/chat") {
        if (req.method !== "POST") return fail(405, "method not allowed");
        const parsed = ChatRequest.safeParse(await body(req));
        if (!parsed.success) return fail(400, "invalid request", z.treeifyError(parsed.error));
        return json(await runChat(env, parsed.data));
      }
      return await handleApi(req, env, url);
    } catch (e) {
      console.error("unhandled", e);
      return fail(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

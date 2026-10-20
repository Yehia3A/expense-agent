import { z } from "zod";
import { ChatRequest, runChat } from "./chat/loop";
import { appConfig, type Env, rateLimits } from "./env";
import { ulid } from "./lib/ulid";
import { handleMcp } from "./mcp/server";
import { handleAuth } from "./security/account";
import { authenticate } from "./security/auth";
import { checkLimits, type Limit } from "./security/ratelimit";
import { addExpenses, ItemInput, recentExpenses } from "./tools/expenses";
import { callTool, type ToolOutcome } from "./tools/registry";
import type { ToolContext } from "./tools/types";

// Thin HTTP adapters over the tool layer (plan 6). Static UI files in
// public/ are served by Workers Static Assets for every other path.

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra },
  });

const fail = (status: number, error: string, details?: unknown, extra?: Record<string, string>) =>
  json({ error, details }, status, extra);

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

/**
 * CSRF guard. The API never sends CORS headers, so other sites can't read
 * responses; this also stops them from *sending* writes. A browser always
 * attaches Origin to cross-site POSTs, and JSON bodies need a preflight.
 */
function crossSiteWrite(req: Request, url: URL): string | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return "cross-origin request refused";
  if (req.headers.get("sec-fetch-site") === "cross-site") return "cross-site request refused";
  const type = req.headers.get("content-type") ?? "";
  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
  if (hasBody && !type.toLowerCase().startsWith("application/json")) return "content-type must be application/json";
  return null;
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

  if (path === "/api/report" && method === "GET") {
    return fromOutcome(await callTool(apiCtx(env), "monthly_report", { month: q.month || undefined }));
  }

  if (path === "/api/history" && method === "GET") {
    return fromOutcome(
      await callTool(apiCtx(env), "monthly_history", {
        end_month: q.end_month || undefined,
        ...(q.months ? { months: Number(q.months) } : {}),
      }),
    );
  }

  if (path === "/api/top" && method === "GET") {
    return fromOutcome(
      await callTool(apiCtx(env), "top_spending", {
        start_date: q.start_date,
        end_date: q.end_date,
        by: q.by || undefined,
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    );
  }

  return fail(404, "not found");
}

export interface HandlerDeps {
  /** Outbound fetch for the LLM and the Access certs; injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function handle(req: Request, env: Env, deps: HandlerDeps = {}): Promise<Response> {
  const url = new URL(req.url);
  const isChat = url.pathname === "/chat";
  const isMcp = url.pathname === "/mcp";
  if (!isChat && !isMcp && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

  const csrf = crossSiteWrite(req, url);
  if (csrf) return fail(403, csrf);
  const now = deps.now?.().getTime() ?? Date.now();

  // Sign-in, sign-out and first-account setup work before authentication.
  if (url.pathname.startsWith("/api/auth/")) {
    try {
      return (await handleAuth(req, env, url, now)) ?? fail(404, "not found");
    } catch (e) {
      console.error("auth error", e);
      return fail(500, "internal error");
    }
  }

  const auth = await authenticate(req, env, { fetchImpl: deps.fetchImpl, now });
  if (!auth.ok) return fail(auth.status, auth.error);
  const res = await route(req, env, url, isChat, isMcp, deps);
  // A session used after a day gets its 30 days back; send the refreshed cookie along.
  if (auth.setCookie) res.headers.append("set-cookie", auth.setCookie);
  return res;
}

async function route(req: Request, env: Env, url: URL, isChat: boolean, isMcp: boolean, deps: HandlerDeps): Promise<Response> {
  try {
    const lim = rateLimits(env);
    const limits: Limit[] = [{ bucket: "api:min", windowSec: 60, max: lim.apiPerMin }];
    if (isChat) {
      limits.push({ bucket: "chat:min", windowSec: 60, max: lim.chatPerMin }, { bucket: "chat:day", windowSec: 86400, max: lim.chatPerDay });
    }
    const rl = await checkLimits(env.DB, limits, deps.now?.().getTime());
    if (!rl.ok) {
      return fail(429, "rate limit reached, try again later", { bucket: rl.bucket }, { "retry-after": String(rl.retryAfterSec) });
    }

    if (isMcp) return await handleMcp(req, env, { now: deps.now });
    if (isChat) {
      if (req.method !== "POST") return fail(405, "method not allowed");
      const parsed = ChatRequest.safeParse(await body(req));
      if (!parsed.success) return fail(400, "invalid request", z.treeifyError(parsed.error));
      return json(await runChat(env, parsed.data, { fetchImpl: deps.fetchImpl, now: deps.now }));
    }
    return await handleApi(req, env, url);
  } catch (e) {
    console.error("unhandled", e);
    return fail(500, "internal error");
  }
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
} satisfies ExportedHandler<Env>;

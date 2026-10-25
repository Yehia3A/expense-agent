import { z } from "zod";
import { accountCurrency } from "../tools/currency";
import { accountLocation } from "../tools/location";
import type { Env } from "../env";
import { ulid } from "../lib/ulid";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./passwords";
import { checkLimits, type Limit } from "./ratelimit";
import {
  clearCookie,
  createSession,
  deleteOtherSessions,
  deleteSession,
  getSession,
  newToken,
  readSessionToken,
  sessionCookie,
  sha256Hex,
} from "./sessions";

// /api/auth/*: accounts (D32, D34). Anyone can create an account with just a
// username and password (unless SIGNUP_OPEN is "off"); each account only ever
// sees its own data. MCP clients and scripts use a personal API token.

const Username = z
  .string()
  .trim()
  .min(3, "Username: at least 3 characters")
  .max(40, "Username: at most 40 characters")
  .regex(/^[A-Za-z0-9._@-]+$/, "Username: letters, numbers and . _ @ - only");
const NewPassword = z.string().min(10, "Password: at least 10 characters").max(200);

/** Every table holding one account's data, for account deletion. */
const USER_TABLES = ["expenses", "budgets", "legacy_monthly_totals", "merchant_map", "user_categories", "logs", "api_tokens", "sessions"];

export const signupOpen = (env: Env) => (env.SIGNUP_OPEN ?? "on").toLowerCase() !== "off";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "local";

async function limited(env: Env, limits: Limit[], now: number, message: string): Promise<Response | null> {
  const r = await checkLimits(env.DB, limits, now);
  return r.ok ? null : json({ error: message }, 429, { "retry-after": String(r.retryAfterSec) });
}

/** Brute-force guard for password checks: per client IP and overall (R3). */
const loginLimits = (req: Request): Limit[] => [
  { bucket: `login:ip:${clientIp(req)}`, windowSec: 900, max: 10 },
  { bucket: "login:all", windowSec: 3600, max: 300 },
];

/** Bot guard for sign-ups: a few per IP per day, and a daily ceiling that keeps the free D1 quota safe. */
const signupLimits = (req: Request): Limit[] => [
  { bucket: `signup:ip:${clientIp(req)}`, windowSec: 86400, max: 5 },
  { bucket: "signup:all", windowSec: 86400, max: 300 },
];

function issues(e: z.ZodError) {
  return e.issues.map((i) => i.message).join("; ");
}

export async function handleAuth(req: Request, env: Env, url: URL, now: number): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "");
  const secure = url.protocol === "https:";
  const ua = req.headers.get("user-agent");
  const token = readSessionToken(req);
  const session = async () => (token ? await getSession(env.DB, token, now) : null);

  if (path === "/api/auth/me" && req.method === "GET") {
    const s = await session();
    if (s) {
      const t = await env.DB.prepare("SELECT created_at, last_used_at FROM api_tokens WHERE user_id = ?")
        .bind(s.user_id)
        .first<{ created_at: string; last_used_at: string | null }>();
      const setup = !(await env.DB.prepare("SELECT 1 FROM user_categories WHERE user_id = ? LIMIT 1").bind(s.user_id).first());
      const currency = await accountCurrency(env.DB, s.user_id);
      const { timezone, city } = await accountLocation(env.DB, s.user_id);
      return json(
        { authenticated: true, username: s.username, api_token: t ?? null, needs_setup: setup, currency, timezone, city },
        200,
        s.renewed ? { "set-cookie": sessionCookie(token!, secure) } : {},
      );
    }
    return json({ authenticated: false, signup_open: signupOpen(env) });
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    const stop = await limited(env, loginLimits(req), now, "Too many sign-in attempts. Try again in a few minutes.");
    if (stop) return stop;
    const b = (await body(req)) as { username?: unknown; password?: unknown } | undefined;
    const username = typeof b?.username === "string" ? b.username.trim() : "";
    const password = typeof b?.password === "string" ? b.password : "";
    const user = username
      ? await env.DB.prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
          .bind(username)
          .first<{ id: string; username: string; password_hash: string }>()
      : null;
    // Always run the hash, so an unknown username takes as long as a wrong password.
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || !password) return json({ error: "Wrong username or password." }, 401);
    const t = await createSession(env.DB, user.id, ua, now);
    return json({ authenticated: true, username: user.username }, 200, { "set-cookie": sessionCookie(t, secure) });
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    if (token) await deleteSession(env.DB, token);
    return json({ authenticated: false }, 200, { "set-cookie": clearCookie(secure) });
  }

  if (path === "/api/auth/signup" && req.method === "POST") {
    if (!signupOpen(env)) return json({ error: "New sign-ups are closed right now." }, 403);
    const parsed = z
      .object({ username: Username, password: NewPassword })
      .safeParse(await body(req));
    if (!parsed.success) return json({ error: issues(parsed.error) }, 400);
    const stop = await limited(env, signupLimits(req), now, "Too many new accounts from this network today. Try again tomorrow.");
    if (stop) return stop;
    const id = ulid(now);
    const iso = new Date(now).toISOString();
    const res = await env.DB.prepare(
      `INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (username) DO NOTHING`,
    )
      .bind(id, parsed.data.username, await hashPassword(parsed.data.password), iso, iso)
      .run();
    if (!res.meta.changes) return json({ error: "That username is taken. Pick another one." }, 409);
    const t = await createSession(env.DB, id, ua, now);
    return json({ authenticated: true, username: parsed.data.username }, 200, { "set-cookie": sessionCookie(t, secure) });
  }

  // Everything below needs a signed-in browser session.
  if (!path.startsWith("/api/auth/")) return null;
  const known = ["/api/auth/password", "/api/auth/delete", "/api/auth/token"];
  if (!known.includes(path)) return null;
  const s = await session();
  if (!s) return json({ error: "Not signed in." }, 401);

  if (path === "/api/auth/password" && req.method === "POST") {
    const stop = await limited(env, loginLimits(req), now, "Too many attempts. Try again in a few minutes.");
    if (stop) return stop;
    const parsed = z.object({ current_password: z.string(), new_password: NewPassword }).safeParse(await body(req));
    if (!parsed.success) return json({ error: issues(parsed.error) }, 400);
    const user = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(s.user_id).first<{ password_hash: string }>();
    if (!user || !(await verifyPassword(parsed.data.current_password, user.password_hash))) {
      return json({ error: "Current password is wrong." }, 403);
    }
    await env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .bind(await hashPassword(parsed.data.new_password), new Date(now).toISOString(), s.user_id)
      .run();
    await deleteOtherSessions(env.DB, s.user_id, token);
    return json({ ok: true, message: "Password changed. Other devices were signed out." });
  }

  // Delete the account and every row of its data. Needs the password.
  if (path === "/api/auth/delete" && req.method === "POST") {
    const stop = await limited(env, loginLimits(req), now, "Too many attempts. Try again in a few minutes.");
    if (stop) return stop;
    const b = (await body(req)) as { password?: unknown } | undefined;
    const user = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(s.user_id).first<{ password_hash: string }>();
    if (!user || typeof b?.password !== "string" || !(await verifyPassword(b.password, user.password_hash))) {
      return json({ error: "Password is wrong." }, 403);
    }
    await env.DB.batch([
      ...USER_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(s.user_id)),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(s.user_id),
    ]);
    return json({ ok: true }, 200, { "set-cookie": clearCookie(secure) });
  }

  // Personal API token for MCP clients and scripts: shown once, only its SHA-256 is kept.
  if (path === "/api/auth/token" && req.method === "POST") {
    const raw = `ea_${newToken()}`;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(s.user_id),
      env.DB.prepare("INSERT INTO api_tokens (id, user_id, created_at) VALUES (?, ?, ?)").bind(await sha256Hex(raw), s.user_id, new Date(now).toISOString()),
    ]);
    return json({ token: raw, message: "Copy it now: it won't be shown again. Creating a new one replaces it." });
  }
  if (path === "/api/auth/token" && req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(s.user_id).run();
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

import { z } from "zod";
import type { Env } from "../env";
import { ulid } from "../lib/ulid";
import { sameToken } from "./auth";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./passwords";
import { checkLimits } from "./ratelimit";
import {
  clearCookie,
  countUsers,
  createSession,
  deleteOtherSessions,
  deleteSession,
  getSession,
  readSessionToken,
  sessionCookie,
} from "./sessions";

// /api/auth/*: the browser's way in (D32). Scripts and MCP clients keep using
// `Authorization: Bearer <APP_TOKEN>`.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const Username = z
  .string()
  .trim()
  .min(3, "at least 3 characters")
  .max(40)
  .regex(/^[A-Za-z0-9._@-]+$/, "letters, numbers and . _ @ - only");
const NewPassword = z.string().min(10, "at least 10 characters").max(200);

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

/** Brute-force guard for login and setup: per client IP and overall (R3). */
async function loginLimited(req: Request, env: Env, now: number): Promise<Response | null> {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const r = await checkLimits(
    env.DB,
    [
      { bucket: `login:ip:${ip}`, windowSec: 900, max: 10 },
      { bucket: "login:all", windowSec: 3600, max: 60 },
    ],
    now,
  );
  return r.ok ? null : json({ error: "Too many sign-in attempts. Try again in a few minutes." }, 429, { "retry-after": String(r.retryAfterSec) });
}

export async function handleAuth(req: Request, env: Env, url: URL, now: number): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "");
  const secure = url.protocol === "https:";
  const ua = req.headers.get("user-agent");

  if (path === "/api/auth/me" && req.method === "GET") {
    const token = readSessionToken(req);
    const s = token ? await getSession(env.DB, token, now) : null;
    if (s) {
      return json({ authenticated: true, username: s.username }, 200, s.renewed ? { "set-cookie": sessionCookie(token!, secure) } : {});
    }
    const users = await countUsers(env.DB);
    return json({
      authenticated: false,
      setup_required: users === 0,
      // Locally with no APP_TOKEN the first account needs no setup key.
      setup_key_required: users === 0 && !(LOCAL_HOSTS.has(url.hostname) && !env.APP_TOKEN),
    });
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    const limited = await loginLimited(req, env, now);
    if (limited) return limited;
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
    const token = await createSession(env.DB, user.id, ua, now);
    return json({ authenticated: true, username: user.username }, 200, { "set-cookie": sessionCookie(token, secure) });
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const token = readSessionToken(req);
    if (token) await deleteSession(env.DB, token);
    return json({ authenticated: false }, 200, { "set-cookie": clearCookie(secure) });
  }

  // First account. Only while no account exists, and (except on localhost
  // without APP_TOKEN) only with the APP_TOKEN as a one-time setup key.
  if (path === "/api/auth/setup" && req.method === "POST") {
    const limited = await loginLimited(req, env, now);
    if (limited) return limited;
    if ((await countUsers(env.DB)) > 0) return json({ error: "An account already exists. Sign in instead." }, 409);
    const parsed = z
      .object({ username: Username, password: NewPassword, setup_key: z.string().optional() })
      .safeParse(await body(req));
    if (!parsed.success) return json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const keyRequired = !(LOCAL_HOSTS.has(url.hostname) && !env.APP_TOKEN);
    if (keyRequired && !(env.APP_TOKEN && parsed.data.setup_key && sameToken(parsed.data.setup_key.trim(), env.APP_TOKEN))) {
      return json({ error: "The setup key is not right. It is the APP_TOKEN printed by npm run setup:cloudflare." }, 403);
    }
    const id = ulid(now);
    const iso = new Date(now).toISOString();
    try {
      await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, parsed.data.username, await hashPassword(parsed.data.password), iso, iso)
        .run();
    } catch {
      return json({ error: "An account already exists. Sign in instead." }, 409);
    }
    const token = await createSession(env.DB, id, ua, now);
    return json({ authenticated: true, username: parsed.data.username }, 200, { "set-cookie": sessionCookie(token, secure) });
  }

  if (path === "/api/auth/password" && req.method === "POST") {
    const token = readSessionToken(req);
    const s = token ? await getSession(env.DB, token, now) : null;
    if (!s) return json({ error: "Not signed in." }, 401);
    const limited = await loginLimited(req, env, now);
    if (limited) return limited;
    const parsed = z.object({ current_password: z.string(), new_password: NewPassword }).safeParse(await body(req));
    if (!parsed.success) return json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
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

  return null;
}

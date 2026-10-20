import type { Env } from "../env";
import { accessToken, verifyAccessJwt } from "./access";
import { countUsers, getSession, readSessionToken, sessionCookie } from "./sessions";

// Who may call /api and /chat (plan 11, O6: no unauthenticated access).
//
//   1. `Authorization: Bearer <APP_TOKEN>`, when APP_TOKEN is set (scripts, MCP clients).
//   2. A valid Cloudflare Access JWT, when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set.
//   3. A signed-in browser session (username + password, 30-day cookie; D32).
//   4. With nothing configured and no account created yet, only localhost is served
//      (wrangler dev). A deployed Worker in that state refuses every request.

export type AuthResult =
  | { ok: true; via: "access" | "token" | "session" | "local"; email?: string | null; username?: string; setCookie?: string }
  | { ok: false; status: 401 | 503; error: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Constant-time comparison so the token can't be guessed byte by byte from timing. */
export function sameToken(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function authenticate(req: Request, env: Env, deps: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<AuthResult> {
  const accessOn = !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
  const tokenOn = !!env.APP_TOKEN;

  if (tokenOn) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (m && sameToken(m[1]!.trim(), env.APP_TOKEN!)) return { ok: true, via: "token" };
  }

  if (accessOn) {
    const jwt = accessToken(req);
    if (jwt) {
      try {
        const r = await verifyAccessJwt(jwt, { teamDomain: env.ACCESS_TEAM_DOMAIN!, aud: env.ACCESS_AUD! }, deps);
        if (r.ok) return { ok: true, via: "access", email: r.email };
      } catch (e) {
        console.error("access verification failed", e);
      }
    }
  }

  const now = deps.now ?? Date.now();
  const url = new URL(req.url);
  const session = readSessionToken(req);
  if (session) {
    const s = await getSession(env.DB, session, now);
    if (s) {
      return {
        ok: true,
        via: "session",
        username: s.username,
        ...(s.renewed ? { setCookie: sessionCookie(session, url.protocol === "https:") } : {}),
      };
    }
  }

  if (!accessOn && !tokenOn && (await countUsers(env.DB)) === 0) {
    if (LOCAL_HOSTS.has(url.hostname)) return { ok: true, via: "local" };
    return { ok: false, status: 503, error: "auth not configured: set APP_TOKEN or Cloudflare Access (see docs/SECURITY.md)" };
  }
  return { ok: false, status: 401, error: "unauthorized" };
}

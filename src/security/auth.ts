import type { Env } from "../env";
import { accessToken, verifyAccessJwt } from "./access";
import { countUsers, getSession, readSessionToken, sessionCookie, sha256Hex } from "./sessions";

// Who is calling (D34: every account sees only its own data).
//
//   Gate (optional): when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, every API
//   request must also carry a valid Cloudflare Access JWT. For a public app
//   leave them empty.
//
//   Identity, first match wins:
//     1. `Authorization: Bearer <personal API token>` (MCP clients, scripts).
//     2. The browser's session cookie (username + password sign-in).
//     3. Local development only: on localhost, before any account exists,
//        requests act as the built-in "local" user.

export const LOCAL_USER = "local";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface Identity {
  userId: string;
  username: string;
  via: "token" | "session" | "local";
  /** Refreshed session cookie to send back (the 30 days slid forward). */
  setCookie?: string;
}

export const accessEnabled = (env: Env) => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

/** The optional Cloudflare Access gate. Always passes when Access isn't configured. */
export async function accessGate(req: Request, env: Env, deps: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<boolean> {
  if (!accessEnabled(env)) return true;
  const jwt = accessToken(req);
  if (!jwt) return false;
  try {
    return (await verifyAccessJwt(jwt, { teamDomain: env.ACCESS_TEAM_DOMAIN!, aud: env.ACCESS_AUD! }, deps)).ok;
  } catch (e) {
    console.error("access verification failed", e);
    return false;
  }
}

export async function identify(req: Request, env: Env, now: number): Promise<Identity | null> {
  const url = new URL(req.url);

  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer) {
    const row = await env.DB.prepare(
      `SELECT t.id, t.last_used_at, u.id AS user_id, u.username
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
    )
      .bind(await sha256Hex(bearer))
      .first<{ id: string; last_used_at: string | null; user_id: string; username: string }>();
    if (!row) return null; // a wrong token never falls back to anything else
    if (!row.last_used_at || now - Date.parse(row.last_used_at) > 86_400_000) {
      await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(new Date(now).toISOString(), row.id).run();
    }
    return { userId: row.user_id, username: row.username, via: "token" };
  }

  const session = readSessionToken(req);
  if (session) {
    const s = await getSession(env.DB, session, now);
    if (s) {
      return {
        userId: s.user_id,
        username: s.username,
        via: "session",
        ...(s.renewed ? { setCookie: sessionCookie(session, url.protocol === "https:") } : {}),
      };
    }
  }

  if (LOCAL_HOSTS.has(url.hostname) && !accessEnabled(env) && (await countUsers(env.DB)) === 0) {
    return { userId: LOCAL_USER, username: LOCAL_USER, via: "local" };
  }
  return null;
}

// 30-day browser sessions. The cookie carries a random 256-bit token; D1
// stores only its SHA-256. Sessions slide: once a day of use pushes the
// expiry back to 30 days from now, so a session you use stays signed in,
// and one left alone for 30 days ends.

export const SESSION_DAYS = 30;
export const COOKIE = "ea_session";
const DAY_MS = 86_400_000;

export interface SessionUser {
  user_id: string;
  username: string;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(token: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_DAYS * 86400): string {
  // SameSite=Strict: the cookie is only ever needed by this app's own fetch calls.
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export const clearCookie = (secure: boolean) => sessionCookie("", secure, 0);

export function readSessionToken(req: Request): string | null {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`).exec(req.headers.get("cookie") ?? "");
  return m ? m[1]! : null;
}

export async function createSession(db: D1Database, userId: string, userAgent: string | null, now: number): Promise<string> {
  const token = newToken();
  const iso = new Date(now).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, renewed_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, iso, iso, new Date(now + SESSION_DAYS * DAY_MS).toISOString(), userAgent?.slice(0, 200) ?? null)
    .run();
  return token;
}

/** The signed-in user, or null. `renewed` is true when the expiry was just pushed back (send a fresh cookie). */
export async function getSession(db: D1Database, token: string, now: number): Promise<(SessionUser & { renewed: boolean }) | null> {
  const id = await sha256(token);
  const row = await db
    .prepare(
      `SELECT s.user_id, s.renewed_at, s.expires_at, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .bind(id)
    .first<{ user_id: string; renewed_at: string; expires_at: string; username: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now) {
    await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }
  let renewed = false;
  if (now - Date.parse(row.renewed_at) > DAY_MS) {
    await db
      .prepare("UPDATE sessions SET renewed_at = ?, expires_at = ? WHERE id = ?")
      .bind(new Date(now).toISOString(), new Date(now + SESSION_DAYS * DAY_MS).toISOString(), id)
      .run();
    renewed = true;
  }
  return { user_id: row.user_id, username: row.username, renewed };
}

export async function deleteSession(db: D1Database, token: string) {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
}

/** Sign out everywhere except (optionally) the current session. */
export async function deleteOtherSessions(db: D1Database, userId: string, keepToken: string | null) {
  const keep = keepToken ? await sha256(keepToken) : "";
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(userId, keep).run();
}

export async function countUsers(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? 0;
}

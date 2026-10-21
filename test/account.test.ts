import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { hashPassword, verifyPassword } from "../src/security/passwords";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const HOST = "https://expense-agent.example.workers.dev";
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-20T10:00:00Z");

interface ReqOpts {
  method?: string;
  body?: unknown;
  cookie?: string;
  bearer?: string;
  ip?: string;
  origin?: string;
  host?: string;
}
function req(path: string, o: ReqOpts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": o.ip ?? "203.0.113.7" };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.origin) headers.origin = o.origin;
  return new Request(`${o.host ?? HOST}${path}`, {
    method: o.method ?? (o.body === undefined ? "GET" : "POST"),
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}
const call = (path: string, o: ReqOpts = {}, t = T0, e: typeof env = env) => handle(req(path, o), e, { now: () => new Date(t) });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

let ipSeq = 0;
async function signup(username = "lyn", password = "correct horse battery") {
  // A fresh IP each time so the per-IP sign-up limit doesn't interfere.
  const res = await call("/api/auth/signup", { body: { username, password }, ip: `198.18.0.${++ipSeq % 250}` });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

describe("passwords", () => {
  it("PBKDF2 hashes verify, use a random salt, and reject wrong passwords", async () => {
    const a = await hashPassword("s3cret password");
    const b = await hashPassword("s3cret password");
    expect(a).toMatch(/^pbkdf2-sha256\$20000\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("s3cret password", a)).toBe(true);
    expect(await verifyPassword("s3cret passworD", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("open sign-up (D34)", () => {
  it("me says sign-up is open; anyone can create an account with just a username and password", async () => {
    expect(await (await call("/api/auth/me")).json()).toEqual({ authenticated: false, signup_open: true });
    const res = await call("/api/auth/signup", { body: { username: "lyn", password: "correct horse battery" } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^ea_session=[A-Za-z0-9_-]{40,};/);
    for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Max-Age=2592000", "Path=/"]) expect(cookie).toContain(flag);
    expect(await (await call("/api/auth/me", { cookie: cookieOf(res) })).json()).toMatchObject({ authenticated: true, username: "lyn" });
  });

  it("several people can sign up; usernames are unique regardless of case", async () => {
    await signup("lyn");
    await signup("sara");
    const dup = await call("/api/auth/signup", { body: { username: "LYN", password: "another long password" } });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toMatch(/taken/);
  });

  it("rejects short passwords and odd usernames", async () => {
    expect((await call("/api/auth/signup", { body: { username: "lyn", password: "short" } })).status).toBe(400);
    expect((await call("/api/auth/signup", { body: { username: "a b", password: "long enough pass" } })).status).toBe(400);
    expect((await call("/api/auth/signup", { body: { username: "ab", password: "long enough pass" } })).status).toBe(400);
  });

  it("can be closed with SIGNUP_OPEN=off; existing accounts still sign in", async () => {
    await signup("lyn");
    const closed = { ...env, SIGNUP_OPEN: "off" };
    expect(await (await call("/api/auth/me", {}, T0, closed)).json()).toEqual({ authenticated: false, signup_open: false });
    expect((await call("/api/auth/signup", { body: { username: "new1", password: "long enough pass" } }, T0, closed)).status).toBe(403);
    expect((await call("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" } }, T0, closed)).status).toBe(200);
  });

  it("limits new accounts per network per day", async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await call("/api/auth/signup", { body: { username: `bot${i}x`, password: "long enough pass" }, ip: "192.0.2.50" })).status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await call("/api/auth/signup", { body: { username: "human1", password: "long enough pass" }, ip: "192.0.2.51" })).status).toBe(200);
  });

  it("stores only a password hash and the session token's SHA-256", async () => {
    await signup();
    const row = await env.DB.prepare("SELECT password_hash FROM users").first<{ password_hash: string }>();
    expect(row!.password_hash).not.toContain("correct horse");
    const s = await env.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    expect(s!.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sign in, sessions, sign out", () => {
  it("wrong password and unknown user get the same answer; the right one gets a session", async () => {
    await signup();
    const bad = await call("/api/auth/login", { body: { username: "lyn", password: "nope nope nope" } });
    const unknown = await call("/api/auth/login", { body: { username: "mallory", password: "nope nope nope" } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual(await unknown.json());
    const good = await call("/api/auth/login", { body: { username: "LYN", password: "correct horse battery" } });
    expect(good.status).toBe(200);
    expect((await call("/api/budget-status", { cookie: cookieOf(good) })).status).toBe(200);
  });

  it("data routes need a sign-in; health does not", async () => {
    await signup();
    expect((await call("/api/budget-status")).status).toBe(401);
    expect((await call("/chat", { body: { message: "hi", request_id: "anon-chat-1" } })).status).toBe(401);
    expect((await call("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status).toBe(401);
    expect((await call("/api/health")).status).toBe(200);
  });

  it("stays signed in for 30 days, sliding with use", async () => {
    const cookie = await signup();
    expect((await call("/api/budget-status", { cookie }, T0 + 29 * DAY)).status).toBe(200);
    expect((await call("/api/budget-status", { cookie }, T0 + 58 * DAY)).status).toBe(200);
    expect((await call("/api/budget-status", { cookie }, T0 + 89 * DAY)).status).toBe(401);
  });

  it("a renewal sends a fresh cookie; same-day use does not", async () => {
    const cookie = await signup();
    expect((await call("/api/budget-status", { cookie }, T0 + 3_600_000)).headers.get("set-cookie")).toBeNull();
    expect((await call("/api/budget-status", { cookie }, T0 + 2 * DAY)).headers.get("set-cookie")).toContain("Max-Age=2592000");
  });

  it("an unused session ends after 30 days", async () => {
    const cookie = await signup();
    expect((await call("/api/budget-status", { cookie }, T0 + 31 * DAY)).status).toBe(401);
  });

  it("sign out ends the session and clears the cookie", async () => {
    const cookie = await signup();
    const out = await call("/api/auth/logout", { body: {}, cookie });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("/api/budget-status", { cookie })).status).toBe(401);
  });

  it("forged cookies are refused", async () => {
    await signup();
    expect((await call("/api/budget-status", { cookie: "ea_session=" + "A".repeat(43) })).status).toBe(401);
  });

  it("once an account exists, localhost needs a sign-in too", async () => {
    await signup();
    expect((await call("/api/budget-status", { host: "http://localhost:8787" })).status).toBe(401);
  });
});

describe("change password and delete account", () => {
  it("changing the password needs the current one and signs out other devices", async () => {
    const mine = await signup();
    const other = cookieOf(await call("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" } }));
    expect((await call("/api/auth/password", { body: { current_password: "nope", new_password: "brand new password" }, cookie: mine })).status).toBe(403);
    expect((await call("/api/auth/password", { body: { current_password: "correct horse battery", new_password: "brand new password" }, cookie: mine })).status).toBe(200);
    expect((await call("/api/budget-status", { cookie: mine })).status).toBe(200);
    expect((await call("/api/budget-status", { cookie: other })).status).toBe(401);
    expect((await call("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" } })).status).toBe(401);
    expect((await call("/api/auth/login", { body: { username: "lyn", password: "brand new password" } })).status).toBe(200);
  });

  it("deleting an account needs the password and removes all of its data, and only its data", async () => {
    const lyn = await signup("lyn");
    const sara = await signup("sara");
    for (const cookie of [lyn, sara]) {
      await call("/api/categories", { method: "PUT", body: { categories: [{ name: "Food & Dining" }, { name: "Groceries" }] }, cookie });
    }
    await call("/api/expenses", { body: { request_id: "lyn-add-0001", items: [{ amount: 50, category: "food_dining", note: "tea" }] }, cookie: lyn });
    await call("/api/expenses", { body: { request_id: "sara-add-001", items: [{ amount: 70, category: "food_dining", note: "juice" }] }, cookie: sara });
    await call("/api/budgets", { method: "PUT", body: { category: "groceries", amount: 3000 }, cookie: lyn });

    expect((await call("/api/auth/delete", { body: { password: "wrong one here" }, cookie: lyn })).status).toBe(403);
    const del = await call("/api/auth/delete", { body: { password: "correct horse battery" }, cookie: lyn });
    expect(del.status).toBe(200);
    expect(del.headers.get("set-cookie")).toContain("Max-Age=0");

    const left = async (table: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = (SELECT id FROM users WHERE username = 'lyn')`).first<{ n: number }>())!.n;
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'lyn'").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await left("expenses")).toBe(0);
    expect((await call("/api/budget-status", { cookie: lyn })).status).toBe(401);
    const saraRows = (await (await call("/api/expenses/recent", { cookie: sara })).json()) as { note: string }[];
    expect(saraRows.map((r) => r.note)).toEqual(["juice"]);
    // The name is free again.
    expect((await call("/api/auth/signup", { body: { username: "lyn", password: "correct horse battery" }, ip: "198.51.100.77" })).status).toBe(200);
  });
});

describe("personal API tokens (MCP clients, scripts)", () => {
  it("a token acts as its own account; a new one replaces the old; revoking ends it", async () => {
    const cookie = await signup();
    const t1 = ((await (await call("/api/auth/token", { body: {}, cookie })).json()) as { token: string }).token;
    expect(t1).toMatch(/^ea_[A-Za-z0-9_-]{40,}$/);
    expect((await call("/api/budget-status", { bearer: t1 })).status).toBe(200);
    expect(((await (await call("/api/auth/me", { cookie })).json()) as { api_token: unknown }).api_token).not.toBeNull();

    const t2 = ((await (await call("/api/auth/token", { body: {}, cookie })).json()) as { token: string }).token;
    expect((await call("/api/budget-status", { bearer: t1 })).status).toBe(401);
    expect((await call("/api/budget-status", { bearer: t2 })).status).toBe(200);

    await call("/api/auth/token", { method: "DELETE", cookie });
    expect((await call("/api/budget-status", { bearer: t2 })).status).toBe(401);
  });

  it("only the token's hash is stored, and a wrong token is just refused", async () => {
    const cookie = await signup();
    const t = ((await (await call("/api/auth/token", { body: {}, cookie })).json()) as { token: string }).token;
    const row = await env.DB.prepare("SELECT id FROM api_tokens").first<{ id: string }>();
    expect(row!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.id).not.toContain(t);
    expect((await call("/api/budget-status", { bearer: "ea_" + "x".repeat(43) })).status).toBe(401);
  });

  it("creating a token needs a signed-in browser, not another token", async () => {
    const cookie = await signup();
    const t = ((await (await call("/api/auth/token", { body: {}, cookie })).json()) as { token: string }).token;
    expect((await call("/api/auth/token", { body: {}, bearer: t })).status).toBe(401);
  });
});

describe("abuse", () => {
  it("rate-limits sign-in attempts per IP", async () => {
    await signup();
    const codes = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await call("/api/auth/login", { body: { username: "lyn", password: `guess ${i} guess` }, ip: "198.51.100.9" })).status);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await call("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" }, ip: "198.51.100.10" })).status).toBe(200);
  });

  it("refuses cross-site sign-in and sign-up posts", async () => {
    await signup();
    const evil = "https://evil.example";
    expect((await call("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" }, origin: evil })).status).toBe(403);
    expect((await call("/api/auth/signup", { body: { username: "victim2", password: "long enough pass" }, origin: evil })).status).toBe(403);
  });
});

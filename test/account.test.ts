import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { hashPassword, verifyPassword } from "../src/security/passwords";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const HOST = "https://expense-agent.example.workers.dev";
const prod = { ...env, APP_TOKEN: "setup-key-123" };
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-20T10:00:00Z");

function req(path: string, opts: { method?: string; body?: unknown; cookie?: string; ip?: string; origin?: string; host?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": opts.ip ?? "203.0.113.7" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  return new Request(`${opts.host ?? HOST}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
const at = (t: number) => ({ now: () => new Date(t) });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function setup(username = "lyn", password = "correct horse battery") {
  const res = await handle(req("/api/auth/setup", { body: { username, password, setup_key: "setup-key-123" } }), prod, at(T0));
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

describe("first account", () => {
  it("me reports that setup is needed and whether a setup key is", async () => {
    const me = await (await handle(req("/api/auth/me"), prod, at(T0))).json();
    expect(me).toEqual({ authenticated: false, setup_required: true, setup_key_required: true });
    const local = await (await handle(req("/api/auth/me", { host: "http://localhost:8787" }), env, at(T0))).json();
    expect(local).toMatchObject({ setup_required: true, setup_key_required: false });
  });

  it("needs the APP_TOKEN as setup key, sets a 30-day HttpOnly Strict Secure cookie, and only works once", async () => {
    const wrong = await handle(req("/api/auth/setup", { body: { username: "lyn", password: "correct horse battery", setup_key: "nope" } }), prod, at(T0));
    expect(wrong.status).toBe(403);
    const ok = await handle(req("/api/auth/setup", { body: { username: "lyn", password: "correct horse battery", setup_key: "setup-key-123" } }), prod, at(T0));
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^ea_session=[A-Za-z0-9_-]{40,};/);
    for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Max-Age=2592000", "Path=/"]) expect(cookie).toContain(flag);
    const again = await handle(req("/api/auth/setup", { body: { username: "eve", password: "another long password", setup_key: "setup-key-123" } }), prod, at(T0));
    expect(again.status).toBe(409);
  });

  it("rejects short passwords and odd usernames", async () => {
    const short = await handle(req("/api/auth/setup", { body: { username: "lyn", password: "short", setup_key: "setup-key-123" } }), prod, at(T0));
    expect(short.status).toBe(400);
    const odd = await handle(req("/api/auth/setup", { body: { username: "a b", password: "long enough pass", setup_key: "setup-key-123" } }), prod, at(T0));
    expect(odd.status).toBe(400);
  });

  it("the stored password is a hash, never the password", async () => {
    await setup();
    const row = await env.DB.prepare("SELECT password_hash FROM users").first<{ password_hash: string }>();
    expect(row!.password_hash).not.toContain("correct horse");
    const s = await env.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    expect(s!.id).toMatch(/^[0-9a-f]{64}$/); // only the token's SHA-256
  });
});

describe("sign in, sessions, sign out", () => {
  it("wrong password and unknown user get the same answer; the right one gets a session", async () => {
    await setup();
    const bad = await handle(req("/api/auth/login", { body: { username: "lyn", password: "nope nope nope" } }), prod, at(T0));
    const unknown = await handle(req("/api/auth/login", { body: { username: "mallory", password: "nope nope nope" } }), prod, at(T0));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual(await unknown.json());
    const good = await handle(req("/api/auth/login", { body: { username: "LYN", password: "correct horse battery" } }), prod, at(T0));
    expect(good.status).toBe(200);
    const cookie = cookieOf(good);
    expect((await handle(req("/api/health", { cookie }), prod, at(T0))).status).toBe(200);
    expect(await (await handle(req("/api/auth/me", { cookie }), prod, at(T0))).json()).toEqual({ authenticated: true, username: "lyn" });
  });

  it("stays signed in for 30 days, sliding with use", async () => {
    const cookie = await setup();
    expect((await handle(req("/api/health", { cookie }), prod, at(T0 + 29 * DAY))).status).toBe(200);
    // That use renewed it: another 30 days from day 29.
    expect((await handle(req("/api/health", { cookie }), prod, at(T0 + 58 * DAY))).status).toBe(200);
    expect((await handle(req("/api/health", { cookie }), prod, at(T0 + 89 * DAY))).status).toBe(401);
  });

  it("a renewal sends a fresh cookie; same-day use does not", async () => {
    const cookie = await setup();
    const same = await handle(req("/api/health", { cookie }), prod, at(T0 + 3_600_000));
    expect(same.headers.get("set-cookie")).toBeNull();
    const later = await handle(req("/api/health", { cookie }), prod, at(T0 + 2 * DAY));
    expect(later.headers.get("set-cookie")).toContain("Max-Age=2592000");
  });

  it("an unused session ends after 30 days", async () => {
    const cookie = await setup();
    expect((await handle(req("/api/health", { cookie }), prod, at(T0 + 31 * DAY))).status).toBe(401);
  });

  it("sign out ends the session and clears the cookie", async () => {
    const cookie = await setup();
    const out = await handle(req("/api/auth/logout", { body: {}, cookie }), prod, at(T0));
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await handle(req("/api/health", { cookie }), prod, at(T0))).status).toBe(401);
  });

  it("forged cookies are refused", async () => {
    await setup();
    expect((await handle(req("/api/health", { cookie: "ea_session=" + "A".repeat(43) }), prod, at(T0))).status).toBe(401);
  });

  it("once an account exists, localhost needs a sign-in too", async () => {
    await setup();
    expect((await handle(req("/api/health", { host: "http://localhost:8787" }), env, at(T0))).status).toBe(401);
  });

  it("APP_TOKEN still works for scripts and MCP clients", async () => {
    await setup();
    const r = await handle(new Request(`${HOST}/api/health`, { headers: { authorization: "Bearer setup-key-123" } }), prod, at(T0));
    expect(r.status).toBe(200);
  });
});

describe("change password", () => {
  it("needs the current password, then signs out other devices", async () => {
    const mine = await setup();
    const other = cookieOf(await handle(req("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" } }), prod, at(T0)));
    const wrong = await handle(req("/api/auth/password", { body: { current_password: "nope", new_password: "brand new password" }, cookie: mine }), prod, at(T0));
    expect(wrong.status).toBe(403);
    const ok = await handle(req("/api/auth/password", { body: { current_password: "correct horse battery", new_password: "brand new password" }, cookie: mine }), prod, at(T0));
    expect(ok.status).toBe(200);
    expect((await handle(req("/api/health", { cookie: mine }), prod, at(T0))).status).toBe(200);
    expect((await handle(req("/api/health", { cookie: other }), prod, at(T0))).status).toBe(401);
    const oldPw = await handle(req("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" } }), prod, at(T0));
    expect(oldPw.status).toBe(401);
    const newPw = await handle(req("/api/auth/login", { body: { username: "lyn", password: "brand new password" } }), prod, at(T0));
    expect(newPw.status).toBe(200);
  });
});

describe("abuse", () => {
  it("rate-limits sign-in attempts per IP", async () => {
    await setup();
    const codes = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await handle(req("/api/auth/login", { body: { username: "lyn", password: `guess ${i} guess` }, ip: "198.51.100.9" }), prod, at(T0))).status);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    // Another IP is not blocked by that.
    expect((await handle(req("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" }, ip: "198.51.100.10" }), prod, at(T0))).status).toBe(200);
  });

  it("refuses cross-site sign-in posts", async () => {
    await setup();
    const r = await handle(req("/api/auth/login", { body: { username: "lyn", password: "correct horse battery" }, origin: "https://evil.example" }), prod, at(T0));
    expect(r.status).toBe(403);
  });
});

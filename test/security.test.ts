import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { clearJwksCache } from "../src/security/access";
import { resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  clearJwksCache();
});

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";

// ---------- a fake Cloudflare Access issuer ----------
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

async function sign(key: { kid: string; privateKey: CryptoKey }, claims: Record<string, unknown>): Promise<string> {
  const head = enc({ alg: "RS256", kid: key.kid, typ: "JWT" });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const goodClaims = (extra: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  email: "me@example.com",
  iat: nowSec(),
  exp: nowSec() + 3600,
  ...extra,
});

function certsFetch(getKeys: () => JsonWebKey[]) {
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) {
      calls++;
      return Response.json({ keys: getKeys() });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const accessEnv = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const get = (url: string, headers: Record<string, string> = {}, e: typeof env = accessEnv, deps = {}) =>
  handle(new Request(url, { headers }), e, deps);

describe("Cloudflare Access JWT (plan 11)", () => {
  it("accepts a valid JWT from the header or the CF_Authorization cookie", async () => {
    const key = await keypair("k1");
    const certs = certsFetch(() => [key.jwk]);
    const jwt = await sign(key, goodClaims());
    expect((await get("https://ea.example.workers.dev/api/health", { "cf-access-jwt-assertion": jwt }, accessEnv, certs)).status).toBe(200);
    expect((await get("https://ea.example.workers.dev/api/health", { cookie: `x=1; CF_Authorization=${jwt}` }, accessEnv, certs)).status).toBe(200);
    expect(certs.calls()).toBe(1); // keys are cached
  });

  it.each([
    ["wrong audience", { aud: ["someone-else"] }],
    ["expired", { exp: nowSec() - 10 }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["not yet valid", { nbf: nowSec() + 3600 }],
  ])("rejects a JWT with %s", async (_label, extra) => {
    const key = await keypair("k1");
    const certs = certsFetch(() => [key.jwk]);
    const jwt = await sign(key, goodClaims(extra));
    expect((await get("https://ea.example.workers.dev/api/health", { "cf-access-jwt-assertion": jwt }, accessEnv, certs)).status).toBe(401);
  });

  it("rejects a JWT signed by another key with the same kid", async () => {
    const real = await keypair("k1");
    const forged = await keypair("k1");
    const certs = certsFetch(() => [real.jwk]);
    const jwt = await sign(forged, goodClaims());
    expect((await get("https://ea.example.workers.dev/api/health", { "cf-access-jwt-assertion": jwt }, accessEnv, certs)).status).toBe(401);
  });

  it("rejects garbage and missing tokens (direct Worker URL without Access)", async () => {
    const key = await keypair("k1");
    const certs = certsFetch(() => [key.jwk]);
    expect((await get("https://ea.example.workers.dev/api/health", {}, accessEnv, certs)).status).toBe(401);
    expect((await get("https://ea.example.workers.dev/api/health", { "cf-access-jwt-assertion": "a.b.c" }, accessEnv, certs)).status).toBe(401);
    expect((await get("https://ea.example.workers.dev/api/health", { "cf-access-jwt-assertion": "nope" }, accessEnv, certs)).status).toBe(401);
  });

  it("picks up rotated keys by refetching once", async () => {
    const oldKey = await keypair("old");
    const newKey = await keypair("new");
    let keys = [oldKey.jwk];
    const certs = certsFetch(() => keys);
    const first = await sign(oldKey, goodClaims());
    expect((await get("https://ea.example.workers.dev/api/health", { "cf-access-jwt-assertion": first }, accessEnv, certs)).status).toBe(200);
    keys = [newKey.jwk];
    const second = await sign(newKey, goodClaims());
    expect((await get("https://ea.example.workers.dev/api/health", { "cf-access-jwt-assertion": second }, accessEnv, certs)).status).toBe(200);
    expect(certs.calls()).toBe(2);
  });

  it("does not trust localhost once Access is configured", async () => {
    expect((await get("http://localhost/api/health", {}, accessEnv)).status).toBe(401);
  });
});

describe("auth modes", () => {
  it("before any account exists only localhost acts as the local user; a deployed Worker needs a sign-in", async () => {
    expect((await get("http://localhost/api/budget-status", {}, env)).status).toBe(200);
    expect((await get("http://127.0.0.1/api/budget-status", {}, env)).status).toBe(200);
    expect((await get("https://ea.example.workers.dev/api/budget-status", {}, env)).status).toBe(401);
    expect((await get("https://ea.example.workers.dev/api/health", {}, env)).status).toBe(200);
  });

  it("Access, when configured, is an extra gate in front of the sign-in", async () => {
    const key = await keypair("k1");
    const certs = certsFetch(() => [key.jwk]);
    const jwt = await sign(key, goodClaims());
    const signup = await handle(
      new Request("https://ea.example.workers.dev/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": jwt },
        body: JSON.stringify({ username: "gated", password: "long enough password" }),
      }),
      accessEnv,
      certs,
    );
    expect(signup.status).toBe(200);
    const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await get("https://ea.example.workers.dev/api/budget-status", { cookie, "cf-access-jwt-assertion": jwt }, accessEnv, certs)).status).toBe(200);
    expect((await get("https://ea.example.workers.dev/api/budget-status", { cookie }, accessEnv, certs)).status).toBe(401);
    expect((await get("https://ea.example.workers.dev/api/budget-status", { "cf-access-jwt-assertion": jwt }, accessEnv, certs)).status).toBe(401);
  });

  it("static assets are served without hitting auth (Access protects them at the edge)", async () => {
    const r = await handle(new Request("https://ea.example.workers.dev/"), accessEnv);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("ExpenseAgent");
  });
});

describe("CSRF and headers", () => {
  const post = (headers: Record<string, string>, body = JSON.stringify({ category: "groceries", amount: 1 })) =>
    handle(new Request("http://localhost/api/budgets", { method: "PUT", headers, body }), env);

  it("refuses cross-origin writes", async () => {
    expect((await post({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("refuses non-JSON bodies (simple form posts)", async () => {
    expect((await post({ "content-type": "text/plain" })).status).toBe(403);
    expect((await post({ "content-type": "application/x-www-form-urlencoded" }, "category=groceries&amount=1")).status).toBe(403);
  });

  it("accepts same-origin JSON writes", async () => {
    expect((await post({ "content-type": "application/json", origin: "http://localhost" })).status).toBe(200);
  });

  it("API responses carry no CORS headers and do carry security headers", async () => {
    const r = await get("http://localhost/api/health", { origin: "https://evil.example" }, env);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("rate limits (R3)", () => {
  const chat = (e: typeof env, id: string) =>
    handle(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", request_id: id }),
      }),
      e,
      { fetchImpl: (async () => Response.json({ choices: [{ message: { content: "hello" } }] })) as unknown as typeof fetch },
    );

  it("limits /chat per minute and returns Retry-After", async () => {
    const e = { ...env, CHAT_RATE_PER_MIN: "2" };
    expect((await chat(e, "rate-chat-0001")).status).toBe(200);
    expect((await chat(e, "rate-chat-0002")).status).toBe(200);
    const third = await chat(e, "rate-chat-0003");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits /chat per day", async () => {
    const e = { ...env, CHAT_RATE_PER_MIN: "0", CHAT_RATE_PER_DAY: "1" };
    expect((await chat(e, "rate-day-0001")).status).toBe(200);
    expect((await chat(e, "rate-day-0002")).status).toBe(429);
  });

  it("limits the API as a whole", async () => {
    const e = { ...env, API_RATE_PER_MIN: "3" };
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await get("http://localhost/api/health", {}, e)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it("the chat limit does not block the rest of the API", async () => {
    const e = { ...env, CHAT_RATE_PER_MIN: "1" };
    await chat(e, "rate-iso-0001");
    expect((await chat(e, "rate-iso-0002")).status).toBe(429);
    expect((await get("http://localhost/api/budget-status", {}, e)).status).toBe(200);
  });
});

describe("secrets never reach logs", () => {
  it("the LLM key is not stored in the logs table", async () => {
    const e = { ...env, LLM_API_KEY: "sk-very-secret-value" };
    await handle(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "coffee 20", request_id: "secret-test-01" }),
      }),
      e,
      { fetchImpl: (async () => new Response("upstream says no", { status: 401 })) as unknown as typeof fetch },
    );
    const rows = (await env.DB.prepare("SELECT * FROM logs").all()).results;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("sk-very-secret-value");
  });
});

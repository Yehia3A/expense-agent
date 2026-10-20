// Cloudflare Access JWT verification (plan 11).
//
// Access sits in front of the app and adds a signed JWT to every request it
// lets through. Checking that JWT in the Worker means a request that reaches
// the Worker some other way (the raw workers.dev URL, a misconfigured route)
// is still rejected.

export interface AccessConfig {
  teamDomain: string; // e.g. "myteam.cloudflareaccess.com"
  aud: string; // Application Audience (AUD) tag from the Access application
}

export type AccessResult = { ok: true; email: string | null } | { ok: false; reason: string };

interface Jwk extends JsonWebKey {
  kid: string;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

export function clearJwksCache() {
  jwksCache.clear();
}

export function normalizeTeamDomain(d: string): string {
  return d.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
  } catch {
    return null;
  }
}

async function getKeys(teamDomain: string, fetchImpl: typeof fetch, now: number, force = false): Promise<Jwk[]> {
  const cached = jwksCache.get(teamDomain);
  if (!force && cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`could not fetch Access certs (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(teamDomain, { keys, fetchedAt: now });
  return keys;
}

/** Read the Access JWT from the header Access sets, or from its cookie. */
export function accessToken(req: Request): string | null {
  const header = req.headers.get("cf-access-jwt-assertion");
  if (header) return header.trim();
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1]! : null;
}

export async function verifyAccessJwt(
  token: string,
  cfg: AccessConfig,
  deps: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<AccessResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now();
  const teamDomain = normalizeTeamDomain(cfg.teamDomain);

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const header = b64urlJson(parts[0]!);
  const payload = b64urlJson(parts[1]!);
  if (!header || !payload) return { ok: false, reason: "malformed token" };
  if (header.alg !== "RS256") return { ok: false, reason: "unexpected algorithm" };

  let keys = await getKeys(teamDomain, fetchImpl, now);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Access rotates keys; refetch once before giving up.
    keys = await getKeys(teamDomain, fetchImpl, now, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: "unknown signing key" };

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, reason: "bad signature" };

  if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: "wrong issuer" };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.aud)) return { ok: false, reason: "wrong audience" };
  const nowSec = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp < nowSec) return { ok: false, reason: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return { ok: false, reason: "not yet valid" };

  return { ok: true, email: typeof payload.email === "string" ? payload.email : null };
}

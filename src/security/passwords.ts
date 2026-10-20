// PBKDF2-SHA256 password hashing with WebCrypto.
//
// 20,000 iterations is far below the usual guidance (600k) because the
// Workers free plan allows 10 ms of CPU per request and 20k costs about 4 ms.
// Online guessing is stopped by the login rate limits instead (D32); the
// iteration count is stored with each hash, so it can be raised later
// (e.g. on a paid plan) and old hashes keep working.

export const DEFAULT_ITERATIONS = 20_000;
const enc = new TextEncoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

/** Constant-time comparison of equal-length byte arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !iter || !salt || !hash) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  return sameBytes(await derive(password, unb64(salt), iterations), unb64(hash));
}

/** Spent on unknown usernames so a miss takes as long as a wrong password. */
export const DUMMY_HASH = "pbkdf2-sha256$20000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

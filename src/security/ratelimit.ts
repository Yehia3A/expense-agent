// Fixed-window rate limits kept in D1 (plan 11, R3). Buckets are global, not
// per client: the point is to protect the free LLM quota and the database
// from abuse, and there is only one legitimate user.

export interface Limit {
  bucket: string;
  windowSec: number;
  max: number;
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number; bucket: string };

export async function checkLimits(db: D1Database, limits: Limit[], nowMs: number = Date.now()): Promise<LimitResult> {
  const active = limits.filter((l) => l.max > 0);
  if (!active.length) return { ok: true };
  const nowSec = Math.floor(nowMs / 1000);
  const stmts = active.map((l) =>
    db
      .prepare(
        `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(l.bucket, nowSec - (nowSec % l.windowSec)),
  );
  // Housekeeping: drop windows older than two days on roughly 1% of requests.
  if (Math.random() < 0.01) stmts.push(db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(nowSec - 2 * 86400));
  const results = await db.batch<{ count: number }>(stmts);

  for (let i = 0; i < active.length; i++) {
    const l = active[i]!;
    const count = results[i]!.results[0]?.count ?? 0;
    if (count > l.max) {
      const windowEnd = nowSec - (nowSec % l.windowSec) + l.windowSec;
      return { ok: false, retryAfterSec: Math.max(1, windowEnd - nowSec), bucket: l.bucket };
    }
  }
  return { ok: true };
}

// The account's city and time zone (D46). "Today", the current month and
// history follow it; the city is only a label for the settings screen.

/** A real IANA time zone, or null. */
export function normalizeTimezone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone ?? tz;
  } catch {
    return null;
  }
}

export async function accountLocation(db: D1Database, userId: string): Promise<{ timezone: string; city: string | null }> {
  const r = await db.prepare("SELECT timezone, city FROM users WHERE id = ?").bind(userId).first<{ timezone: string; city: string | null }>();
  return { timezone: r?.timezone ?? "Africa/Cairo", city: r?.city ?? null };
}

export async function setAccountLocation(
  db: D1Database,
  userId: string,
  timezone: unknown,
  city: unknown,
): Promise<{ ok: true; timezone: string; city: string | null } | { ok: false; error: string }> {
  const tz = normalizeTimezone(timezone);
  if (!tz) return { ok: false, error: "Pick your city from the list." };
  const label = typeof city === "string" ? city.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120) || null : null;
  await db.prepare("UPDATE users SET timezone = ?, city = ?, updated_at = ? WHERE id = ?").bind(tz, label, new Date().toISOString(), userId).run();
  return { ok: true, timezone: tz, city: label };
}

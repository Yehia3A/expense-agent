import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { systemPrompt } from "../src/chat/prompt";
import { handle } from "../src/index";
import { normalizeTimezone } from "../src/tools/location";
import { resetDb } from "./helpers";

// D46: each account has a city and time zone; "today" follows it.
beforeEach(resetDb);

const HOST = "https://app.example.workers.dev";
// 11:00 UTC: still 19 Oct in Cairo (13:00), already 20 Oct on Kiritimati (UTC+14, 01:00).
const AT = new Date("2026-10-19T11:00:00Z");
let ip = 0;
function req(path: string, cookie: string, init: { method?: string; body?: unknown } = {}) {
  return handle(
    new Request(`${HOST}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", "cf-connecting-ip": `10.7.0.${++ip % 250}`, ...(cookie ? { cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    { now: () => AT },
  );
}
async function newAccount(username: string) {
  const res = await req("/api/auth/signup", "", { body: { username, password: "long enough password" } });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  await req("/api/categories", cookie, { method: "PUT", body: { categories: [{ key: "groceries", name: "Groceries" }] } });
  return cookie;
}
type Me = { timezone: string; city: string | null };

describe("city and time zone", () => {
  it("accepts real IANA time zones only", () => {
    expect(normalizeTimezone("Europe/London")).toBe("Europe/London");
    expect(normalizeTimezone("America/New_York")).toBe("America/New_York");
    for (const bad of ["", "Mars/Olympus", "Cairo", "../etc", 7, null]) expect(normalizeTimezone(bad)).toBeNull();
  });

  it("new accounts start on Cairo time; settings change city and time zone", async () => {
    const cookie = await newAccount("traveller");
    const me = (await (await req("/api/auth/me", cookie)).json()) as Me;
    expect(me).toMatchObject({ timezone: "Africa/Cairo", city: null });
    const ok = await req("/api/settings", cookie, { method: "PUT", body: { timezone: "Europe/London", city: "London, United Kingdom" } });
    expect(ok.status).toBe(200);
    expect(await (await req("/api/auth/me", cookie)).json()).toMatchObject({ timezone: "Europe/London", city: "London, United Kingdom" });
    const bad = await req("/api/settings", cookie, { method: "PUT", body: { timezone: "Mars/Olympus" } });
    expect(bad.status).toBe(400);
  });

  it("setup can save the city with the categories", async () => {
    const res = await req("/api/auth/signup", "", { body: { username: "setupcity", password: "long enough password" } });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const put = await req("/api/categories", cookie, {
      method: "PUT",
      body: { categories: [{ name: "Food" }], currency: "USD", timezone: "America/Chicago", city: "Chicago, United States of America" },
    });
    expect(put.status).toBe(200);
    expect(await (await req("/api/settings", cookie)).json()).toMatchObject({ currency: "USD", timezone: "America/Chicago" });
  });

  it("'today' follows the account's time zone", async () => {
    await env.DB.prepare("INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', 'vegs', 'groceries', 1, 'x')").run();
    const cairo = await newAccount("cairene");
    const island = await newAccount("islander");
    await req("/api/settings", island, { method: "PUT", body: { timezone: "Pacific/Kiritimati", city: "Kiritimati" } });
    const log = async (cookie: string, id: string) =>
      ((await (await req("/chat", cookie, { body: { message: "vegs 300", request_id: id, history: [] } })).json()) as { saved: { expense_date: string }[] }).saved[0]!
        .expense_date;
    expect(await log(cairo, "tz-chat-cairo")).toBe("2026-10-19");
    expect(await log(island, "tz-chat-island")).toBe("2026-10-20");
  });

  it("the chat prompt names the account's time zone", () => {
    expect(systemPrompt("2026-10-19", [], 500, "USD", "America/Chicago")).toContain("(America/Chicago)");
  });
});

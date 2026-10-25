import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { MAX_AUDIO_BYTES } from "../src/voice/transcribe";
import { NOW, resetDb } from "./helpers";

beforeEach(resetDb);

// A fake Groq /audio/transcriptions endpoint that records what it was sent.
function whisper(reply: { status?: number; text?: string } = {}) {
  const seen: { url: string; auth: string | null; form: FormData }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), form: init.body as FormData });
    if (reply.status && reply.status !== 200) return new Response("nope", { status: reply.status });
    return Response.json({ text: reply.text ?? " coffee 200, vegs 400 " });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const clip = (bytes = 2048) => new Uint8Array(bytes).fill(7);
const post = (body: BodyInit, headers: Record<string, string>, fetchImpl?: typeof fetch, e: typeof env = env) =>
  handle(new Request("http://localhost/api/transcribe", { method: "POST", headers, body }), e, { now: () => NOW, fetchImpl });

describe("voice input: /api/transcribe (D40)", () => {
  it("sends the clip to Whisper and returns the text for the message box", async () => {
    const w = whisper();
    const res = await post(clip(), { "content-type": "audio/webm;codecs=opus" }, w.fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "coffee 200, vegs 400" });
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]!.url).toBe("https://llm.test/v1/audio/transcriptions");
    expect(w.seen[0]!.auth).toBe("Bearer test-key");
    const form = w.seen[0]!.form;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(2048);
    expect(String(form.get("prompt"))).toContain("coffee 200");
  });

  it("accepts iPhone recordings (audio/mp4) and names them .m4a", async () => {
    const w = whisper({ text: "uber 85" });
    const res = await post(clip(), { "content-type": "audio/mp4" }, w.fetchImpl);
    expect(await res.json()).toEqual({ text: "uber 85" });
    expect((w.seen[0]!.form.get("file") as File).name).toBe("voice.m4a");
  });

  it("refuses non-audio, empty and oversized bodies without calling Whisper", async () => {
    const w = whisper();
    expect((await post("hello", { "content-type": "text/plain" }, w.fetchImpl)).status).toBe(403); // CSRF guard: not JSON, not audio
    expect((await post(new Uint8Array(0), { "content-type": "audio/webm" }, w.fetchImpl)).status).toBe(400);
    expect((await post(clip(MAX_AUDIO_BYTES + 1), { "content-type": "audio/webm" }, w.fetchImpl)).status).toBe(413);
    expect(w.seen).toHaveLength(0);
  });

  it("audio bodies are only accepted on /api/transcribe", async () => {
    const res = await handle(
      new Request("http://localhost/api/budgets", { method: "PUT", headers: { "content-type": "audio/webm" }, body: clip() }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("refuses cross-site uploads", async () => {
    const w = whisper();
    const res = await post(clip(), { "content-type": "audio/webm", origin: "https://evil.example" }, w.fetchImpl);
    expect(res.status).toBe(403);
    expect(w.seen).toHaveLength(0);
  });

  it("needs a sign-in once accounts exist", async () => {
    await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES ('u1', 'someone', 'x', 'now', 'now')").run();
    const w = whisper();
    expect((await post(clip(), { "content-type": "audio/webm" }, w.fetchImpl)).status).toBe(401);
    expect(w.seen).toHaveLength(0);
  });

  it("limits clips per account per minute, and for everyone per day", async () => {
    const w = whisper();
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await post(clip(), { "content-type": "audio/webm" }, w.fetchImpl)).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);

    await resetDb();
    const shared = { ...env, VOICE_RATE_PER_DAY: "1" };
    expect((await post(clip(), { "content-type": "audio/webm" }, w.fetchImpl, shared)).status).toBe(200);
    const busy = await post(clip(), { "content-type": "audio/webm" }, w.fetchImpl, shared);
    expect(busy.status).toBe(429);
    expect(((await busy.json()) as { error: string }).error).toMatch(/busy for today/);
  });

  it("explains Whisper's own quota errors and a missing key", async () => {
    const quota = await post(clip(), { "content-type": "audio/webm" }, whisper({ status: 429 }).fetchImpl);
    expect(quota.status).toBe(429);
    const noKey = await post(clip(), { "content-type": "audio/webm" }, whisper().fetchImpl, { ...env, LLM_API_KEY: "" });
    expect(noKey.status).toBe(503);
  });

  it("logs the transcript like a chat message, never the audio", async () => {
    await post(clip(), { "content-type": "audio/webm" }, whisper({ text: "gold 2000" }).fetchImpl);
    const row = await env.DB.prepare("SELECT path, user_text, user_id FROM logs WHERE path = 'stt'").first();
    expect(row).toEqual({ path: "stt", user_text: "gold 2000", user_id: "local" });
  });
});

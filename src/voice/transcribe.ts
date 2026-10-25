import type { Env } from "../env";
import { ulid } from "../lib/ulid";
import { checkLimits } from "../security/ratelimit";
import { llmConfig } from "../chat/llm";

// Voice input (D40): the browser records a short clip and posts the raw
// audio here; Groq's free Whisper endpoint turns it into text, which the UI
// puts in the message box. Free tier: 2,000 clips and 28,800 audio seconds a
// day (each clip counts at least 10 s), shared by all accounts.

export const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // ~3 minutes of Opus; the UI stops at 30 s
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|m4a|x-m4a|aac|flac)\b/i;
const EXT: Record<string, string> = { webm: "webm", ogg: "ogg", mp4: "m4a", m4a: "m4a", "x-m4a": "m4a", aac: "m4a", mpeg: "mp3", mp3: "mp3", wav: "wav", "x-wav": "wav", flac: "flac" };

// Spelling hints so Whisper writes amounts as digits and knows the app's words.
const PROMPT = "coffee 200, vegs 400, uber 85 yesterday, squash court 350, Thndr 3000, gold 2000, 2ahwa 50, khodar 300, benzine 600.";

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });

export interface TranscribeDeps {
  userId: string;
  now: number;
  fetchImpl?: typeof fetch;
}

export async function handleTranscribe(req: Request, env: Env, deps: TranscribeDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!AUDIO_TYPES.test(type)) return json({ error: "send the recording as an audio/* body" }, 415);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_AUDIO_BYTES) return json({ error: "recording too long" }, 413);

  // Per account, plus a daily ceiling for everyone that stays under Groq's free quota.
  const limit = await checkLimits(
    env.DB,
    [
      { bucket: `voice:u:${deps.userId}:min`, windowSec: 60, max: 10 },
      { bucket: `voice:u:${deps.userId}:day`, windowSec: 86400, max: 100 },
      { bucket: "voice:all:day", windowSec: 86400, max: Number(env.VOICE_RATE_PER_DAY ?? 1500) || 1500 },
    ],
    deps.now,
  );
  if (!limit.ok) {
    const shared = limit.bucket === "voice:all:day";
    return json(
      { error: shared ? "Voice input is busy for today. Type instead; it still works." : "Too many voice messages. Wait a moment, or type." },
      429,
      { "retry-after": String(limit.retryAfterSec) },
    );
  }

  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0) return json({ error: "empty recording" }, 400);
  if (audio.byteLength > MAX_AUDIO_BYTES) return json({ error: "recording too long" }, 413);

  let cfg;
  try {
    cfg = llmConfig(env);
  } catch (e) {
    return json({ error: (e as Error).message }, 503);
  }
  if (cfg.provider !== "groq" && !env.STT_BASE_URL) return json({ error: "voice input needs Groq (or STT_BASE_URL)" }, 501);

  const sub = type.split(";")[0]!.split("/")[1]!;
  const form = new FormData();
  form.append("file", new Blob([audio], { type: type.split(";")[0] }), `voice.${EXT[sub] ?? "webm"}`);
  form.append("model", env.STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("prompt", PROMPT);

  const started = Date.now();
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${(env.STT_BASE_URL || cfg.baseUrl).replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return json({ error: `speech service unreachable: ${(e as Error).message}` }, 502);
  }
  if (!res.ok) {
    const quota = res.status === 429;
    return json({ error: quota ? "Voice input is busy right now. Try again in a minute, or type." : `speech service error ${res.status}` }, quota ? 429 : 502);
  }
  const text = String(((await res.json()) as { text?: string }).text ?? "").trim();

  await env.DB.prepare(
    `INSERT INTO logs (id, user_id, request_id, ts, user_text, path, model, latency_ms)
     VALUES (?, ?, ?, ?, ?, 'stt', ?, ?)`,
  )
    .bind(ulid(), deps.userId, ulid(), new Date().toISOString(), text, env.STT_MODEL || "whisper-large-v3-turbo", Date.now() - started)
    .run();

  return json({ text });
}


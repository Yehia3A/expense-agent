// Voice input (D40): record a short clip in the browser, stop automatically
// when you stop talking, and turn it into text with Groq Whisper through
// /api/transcribe. Works in every browser that can record audio (Chrome,
// Brave, Edge, Firefox, Safari on iPhone and Mac).

const MAX_MS = 30_000; // hard stop
const SILENCE_MS = 1_400; // stop this long after you stop talking
const NO_SPEECH_MS = 7_000; // give up if nothing is said
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export const voiceSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.isSecureContext);

export class VoiceError extends Error {}

/**
 * Start listening. `onState` gets "listening" | "thinking"; `onLevel` gets
 * 0..1 loudness for the animation. Returns { stop, cancel, result } where
 * `result` resolves to the transcript ("" if nothing was heard).
 */
export function listen({ onState = () => {}, onLevel = () => {} } = {}) {
  let stopFn = () => {};
  let cancelled = false;
  const result = (async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      throw new VoiceError(
        e?.name === "NotAllowedError"
          ? "Microphone blocked. Allow it for this site in the browser's address bar, then try again."
          : "No microphone found.",
      );
    }
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    // Loudness meter for auto-stop and the pulsing button.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = Ctx ? new Ctx() : null;
    const analyser = ctx?.createAnalyser();
    if (ctx && analyser) {
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
    }
    const buf = new Float32Array(1024);
    let floor = 0.01;
    let heardSpeech = false;
    let lastLoud = performance.now();
    const started = performance.now();

    const finished = new Promise((resolve) => {
      rec.onstop = resolve;
    });
    const end = () => {
      if (rec.state !== "inactive") rec.stop();
    };
    stopFn = end;
    rec.start(250);
    onState("listening");

    const timer = setInterval(() => {
      const now = performance.now();
      if (analyser) {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        if (now - started < 400) floor = Math.max(floor, rms); // learn the room noise first
        const threshold = Math.max(0.02, floor * 2.5);
        onLevel(Math.min(1, rms / (threshold * 3)));
        if (rms > threshold) {
          heardSpeech = true;
          lastLoud = now;
        }
        if (heardSpeech && now - lastLoud > SILENCE_MS) end();
        if (!heardSpeech && now - started > NO_SPEECH_MS) end();
      }
      if (now - started > MAX_MS) end();
    }, 100);

    await finished;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop()); // microphone off right away
    ctx?.close();
    onLevel(0);
    if (cancelled) return "";
    if (analyser && !heardSpeech) return "";

    onState("thinking");
    const blob = new Blob(chunks, { type: (rec.mimeType || mimeType || "audio/webm").split(";")[0] });
    if (!blob.size) return "";
    const res = await fetch("/api/transcribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": blob.type },
      body: blob,
    });
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent("auth:required"));
      throw new VoiceError("Your session has ended. Please sign in again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new VoiceError(data.error || `Voice input failed (${res.status}).`);
    return (data.text ?? "").trim();
  })();

  return {
    stop: () => stopFn(),
    cancel: () => {
      cancelled = true;
      stopFn();
    },
    result,
  };
}

/** Short vibration on phones that support it (Android). */
export const buzz = (ms = 30) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};

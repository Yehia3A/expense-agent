// Mic button in the message box, and driving mode: a full-screen view with
// one huge button. Tap, speak, and the expense is sent after a short
// countdown you can cancel. The screen stays on while driving mode is open.
import { $, toast } from "./lib.js";
import { sendChat } from "./track.js";
import { buzz, listen, voiceSupported, VoiceError } from "./voice.js";

const SEND_DELAY_S = 3;

// ---------- mic in the message box: fills the box, you press Send ----------
function wireComposerMic() {
  const mic = $("#mic");
  const input = $("#msg");
  let session = null;
  mic.addEventListener("click", async () => {
    if (session) return session.stop(); // second tap = done talking
    const placeholder = input.placeholder;
    session = listen({
      onState: (s) => {
        mic.dataset.state = s;
        mic.setAttribute("aria-pressed", String(s === "listening"));
        input.placeholder = s === "listening" ? "Listening… tap the mic when you're done" : "Turning speech into text…";
      },
      onLevel: (v) => mic.style.setProperty("--level", v.toFixed(2)),
    });
    try {
      const text = await session.result;
      if (text) {
        input.value = input.value.trim() ? `${input.value.trim()}, ${text}` : text;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } else {
        toast("Didn't catch that. Try again a little closer to the mic.");
      }
    } catch (err) {
      toast(err instanceof VoiceError ? err.message : "Voice input failed.");
    } finally {
      session = null;
      delete mic.dataset.state;
      mic.setAttribute("aria-pressed", "false");
      input.placeholder = placeholder;
    }
  });
}

// ---------- driving mode ----------
const view = () => $("#drive");
let wakeLock = null;
let current = null; // listening session
let countdown = null;

async function keepScreenOn() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null; // not supported or not allowed: the screen may dim
  }
}

function setStatus(text, tone = "") {
  const s = $("#drive-status");
  s.textContent = text;
  s.dataset.tone = tone;
}

function setMic(state, label) {
  const mic = $("#drive-mic");
  mic.dataset.state = state;
  $("#drive-mic-label").textContent = label;
  mic.setAttribute("aria-label", label);
}

function clearCountdown() {
  if (countdown) clearInterval(countdown.timer);
  countdown = null;
  $("#drive-confirm").hidden = true;
}

function idle(message = "Say what you spent, like “coffee 200”.") {
  clearCountdown();
  setMic("idle", "Tap to speak");
  setStatus(message);
}

async function send(text) {
  clearCountdown();
  setMic("busy", "Saving…");
  setStatus("Saving…");
  try {
    const res = await sendChat(text);
    if (res.pending) {
      idle("Needs a check: tap Confirm on it in the chat when you've stopped.");
    } else if (res.saved?.length) {
      // Only a real save is green; the line says where it went and how the budget stands.
      buzz(60);
      idle(res.status_lines.join("\n"));
      setStatus($("#drive-status").textContent, "ok");
    } else {
      // A question or an answer from the assistant: show it as is.
      idle(res.reply || "Nothing was saved.");
      if (res.error) setStatus($("#drive-status").textContent, "bad");
    }
  } catch (err) {
    idle(err.message);
    setStatus(err.message, "bad");
  }
}

function startCountdown(text) {
  let left = SEND_DELAY_S;
  $("#drive-confirm").hidden = false;
  const btn = $("#drive-send");
  btn.textContent = `Send now (${left})`;
  countdown = {
    text,
    timer: setInterval(() => {
      left -= 1;
      if (left <= 0) return send(text);
      btn.textContent = `Send now (${left})`;
    }, 1000),
  };
}

async function micTap() {
  if (countdown) return; // the big Send/Cancel buttons handle that state
  if (current) return current.stop();
  buzz();
  $("#drive-heard").textContent = "";
  current = listen({
    onState: (s) => {
      if (s === "listening") {
        setMic("listening", "Listening… tap when done");
        setStatus("Listening…");
      } else {
        setMic("busy", "One moment…");
        setStatus("Turning speech into text…");
      }
    },
    onLevel: (v) => $("#drive-mic").style.setProperty("--level", v.toFixed(2)),
  });
  try {
    const text = await current.result;
    current = null;
    if (!text) return idle("Didn't catch that. Tap and try again.");
    buzz();
    $("#drive-heard").textContent = `“${text}”`;
    setMic("busy", "Sending soon…");
    setStatus(`Sending in ${SEND_DELAY_S} seconds. Tap Cancel if that's wrong.`);
    startCountdown(text);
  } catch (err) {
    current = null;
    idle(err instanceof VoiceError ? err.message : "Voice input failed.");
    setStatus($("#drive-status").textContent, "bad");
  }
}

export function openDriving() {
  view().hidden = false;
  document.body.classList.add("driving");
  keepScreenOn();
  idle();
  $("#drive-mic").focus();
}

function closeDriving() {
  current?.cancel();
  current = null;
  clearCountdown();
  wakeLock?.release?.();
  wakeLock = null;
  view().hidden = true;
  document.body.classList.remove("driving");
  $("#drive-open").focus();
}

export function initVoice() {
  if (!voiceSupported()) {
    // No recording in this browser (or not on https): hide voice controls.
    for (const id of ["#mic", "#drive-open"]) $(id).hidden = true;
    return;
  }
  wireComposerMic();
  $("#drive-open").addEventListener("click", openDriving);
  $("#drive-exit").addEventListener("click", closeDriving);
  $("#drive-mic").addEventListener("click", micTap);
  $("#drive-send").addEventListener("click", () => countdown && send(countdown.text));
  $("#drive-cancel").addEventListener("click", () => {
    buzz();
    idle("Cancelled. Nothing was saved.");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !view().hidden) closeDriving();
  });
  // The browser drops the wake lock when the tab is hidden; take it again on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !view().hidden) keepScreenOn();
  });
}

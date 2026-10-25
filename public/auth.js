// Welcome screen: sign in, or create a free account (anyone, no email).
// Real <form>s with autocomplete hints so the browser offers to save and
// fill the password.
import { $ } from "./lib.js";

export async function getMe() {
  const res = await fetch("/api/auth/me", { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not reach the app (${res.status}).`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

/** Ask Chromium-based browsers to save the login (others offer it on their own after the form submits). */
async function rememberCredential(form) {
  try {
    if (window.PasswordCredential && navigator.credentials?.store) {
      await navigator.credentials.store(new window.PasswordCredential(form));
    }
  } catch {
    /* the browser said no; nothing to do */
  }
}

function showError(form, message) {
  const box = form.querySelector(".form-error");
  box.textContent = message;
  box.hidden = !message;
}

function busy(form, on) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = on;
  btn.classList.toggle("loading", on);
}

function wire(form, path, payload, validate) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const problem = validate?.(data);
    if (problem) return showError(form, problem);
    showError(form, "");
    busy(form, true);
    try {
      await post(path, payload(data));
      try { localStorage.setItem(KNOWN_KEY, "1"); } catch { /* fine */ }
      await rememberCredential(form);
      // A full reload: the browser sees the login form go away (its cue to save
      // the password), and the app starts with the new session cookie.
      location.replace(location.pathname + "#track");
      location.reload();
    } catch (err) {
      showError(form, err.message);
      busy(form, false);
      const pw = form.querySelector("input[type=password]");
      if (pw && path.endsWith("/login")) {
        pw.value = "";
        pw.focus();
      }
    }
  });
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  wire($("#login-form"), "/api/auth/login", (d) => ({ username: d.username, password: d.password }), (d) =>
    !d.username || !d.password ? "Enter your username and password." : null,
  );
  wire(
    $("#setup-form"),
    "/api/auth/signup",
    (d) => ({ username: d.username, password: d.password }),
    (d) => {
      if (!/^[A-Za-z0-9._@-]{3,40}$/.test(d.username ?? "")) return "Username: 3–40 letters, numbers or . _ @ -";
      if ((d.password ?? "").length < 10) return "Password: at least 10 characters.";
      if (d.password !== d.confirm) return "The passwords don't match.";
      return null;
    },
  );
  $("#auth-tab-signin").addEventListener("click", () => selectTab("signin"));
  $("#auth-tab-signup").addEventListener("click", () => selectTab("signup"));
  for (const btn of document.querySelectorAll(".pw-toggle")) {
    btn.addEventListener("click", () => {
      const input = btn.parentElement.querySelector("input");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.classList.toggle("on", show);
      input.focus();
    });
  }
}

// Remembers that this browser has signed in before, to open on "Sign in" next time.
const KNOWN_KEY = "expenseagent.known";
let signupOpen = true;

function selectTab(tab, message = "") {
  const signup = tab === "signup" && signupOpen;
  $("#auth-tab-signin").setAttribute("aria-selected", String(!signup));
  $("#auth-tab-signup").setAttribute("aria-selected", String(signup));
  $("#login-form").hidden = signup;
  $("#setup-form").hidden = !signup;
  const form = signup ? $("#setup-form") : $("#login-form");
  showError(form, message);
  busy(form, false);
  (signup ? $("#setup-username") : $("#login-username")).focus();
}

export function showWelcome(me, { message } = {}) {
  wireOnce();
  $("#app").hidden = true;
  $("#boot").hidden = true;
  $("#welcome").hidden = false;
  signupOpen = me?.signup_open !== false;
  $("#auth-tab-signup").hidden = !signupOpen;
  $("#signup-closed").hidden = signupOpen;
  let known = false;
  try { known = localStorage.getItem(KNOWN_KEY) === "1"; } catch { /* first visit */ }
  selectTab(known || message || !signupOpen ? "signin" : "signup", message ?? "");
}

export async function signOut() {
  try {
    await post("/api/auth/logout", {});
  } finally {
    location.replace(location.pathname);
    location.reload();
  }
}

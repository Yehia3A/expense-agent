// Welcome screen: sign in, or create the first account. Real <form>s with
// autocomplete hints so the browser offers to save and fill the password.
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
    "/api/auth/setup",
    (d) => ({ username: d.username, password: d.password, setup_key: d.setup_key || undefined }),
    (d) => {
      if (!/^[A-Za-z0-9._@-]{3,40}$/.test(d.username ?? "")) return "Username: 3–40 letters, numbers or . _ @ -";
      if ((d.password ?? "").length < 10) return "Password: at least 10 characters.";
      if (d.password !== d.confirm) return "The passwords don't match.";
      return null;
    },
  );
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

export function showWelcome(me, { message } = {}) {
  wireOnce();
  $("#app").hidden = true;
  $("#boot").hidden = true;
  $("#welcome").hidden = false;
  const setup = !!me?.setup_required;
  $("#login-form").hidden = setup;
  $("#setup-form").hidden = !setup;
  $("#setup-key-field").hidden = !me?.setup_key_required;
  $("#setup-key").required = !!me?.setup_key_required;
  const form = setup ? $("#setup-form") : $("#login-form");
  showError(form, message ?? "");
  busy(form, false);
  (setup ? $(me?.setup_key_required ? "#setup-key" : "#setup-username") : $("#login-username")).focus();
}

export async function signOut() {
  try {
    await post("/api/auth/logout", {});
  } finally {
    location.replace(location.pathname);
    location.reload();
  }
}

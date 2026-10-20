// In-page dialogs that replace the browser's confirm()/prompt() boxes:
// centered card, dimmed backdrop, Esc or a click outside cancels, focus stays inside.
import { api, el, toast } from "./lib.js";

const dlg = document.getElementById("dialog");

dlg.addEventListener("click", (e) => {
  // A click on the backdrop (the dialog element itself, outside the card) cancels.
  if (e.target === dlg) dlg.close("cancel");
});

function open(content, { onClose } = {}) {
  dlg.replaceChildren(content);
  const done = () => {
    dlg.removeEventListener("close", done);
    onClose?.(dlg.returnValue);
  };
  dlg.addEventListener("close", done);
  dlg.returnValue = "";
  dlg.showModal();
}

const ICONS = {
  danger: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z",
};

function icon(kind) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[kind]);
  svg.append(path);
  return el("div", { class: `dialog-icon ${kind}` }, svg);
}

/** Resolves true when confirmed, false when cancelled. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const confirmBtn = el("button", { type: "button", class: danger ? "btn-danger" : "" }, confirmLabel);
    const cancelBtn = el("button", { type: "button", class: "ghost" }, cancelLabel);
    confirmBtn.addEventListener("click", () => dlg.close("ok"));
    cancelBtn.addEventListener("click", () => dlg.close("cancel"));
    open(
      el(
        "div",
        { class: "dialog-card", role: "document" },
        icon(danger ? "danger" : "info"),
        el("h2", { class: "dialog-title" }, title),
        message ? el("p", { class: "dialog-text" }, message) : null,
        el("div", { class: "dialog-actions" }, cancelBtn, confirmBtn),
      ),
      { onClose: (v) => resolve(v === "ok") },
    );
    (danger ? cancelBtn : confirmBtn).focus();
  });
}

function field(label, attrs) {
  return el("label", { class: "field" }, el("span", {}, label), el("input", attrs));
}

export function changePasswordDialog() {
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  const submit = el("button", { type: "submit" }, "Change password");
  const cancel = el("button", { type: "button", class: "ghost" }, "Cancel");
  // A hidden username field lets the browser's password manager update the right entry.
  const user = el("input", { type: "text", name: "username", autocomplete: "username", value: document.body.dataset.username ?? "", hidden: true, tabindex: "-1" });
  const form = el(
    "form",
    { class: "dialog-card", novalidate: true },
    icon("lock"),
    el("h2", { class: "dialog-title" }, "Change password"),
    el("p", { class: "dialog-text" }, "Other devices will be signed out."),
    user,
    field("Current password", { type: "password", name: "current_password", autocomplete: "current-password", required: true }),
    field("New password", { type: "password", name: "new_password", autocomplete: "new-password", required: true, minlength: "10" }),
    field("Repeat new password", { type: "password", name: "confirm", autocomplete: "new-password", required: true }),
    error,
    el("div", { class: "dialog-actions" }, cancel, submit),
  );
  cancel.addEventListener("click", () => dlg.close("cancel"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    if (data.new_password.length < 10) return fail("The new password needs at least 10 characters.");
    if (data.new_password !== data.confirm) return fail("The new passwords don't match.");
    submit.disabled = true;
    try {
      const r = await api("/api/auth/password", { method: "POST", body: { current_password: data.current_password, new_password: data.new_password } });
      dlg.close("ok");
      toast(r.message, "ok");
    } catch (err) {
      fail(err.message);
    } finally {
      submit.disabled = false;
    }
  });
  open(form);
  form.querySelector("[name=current_password]").focus();
}

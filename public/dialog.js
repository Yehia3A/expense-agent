// In-page dialogs that replace the browser's confirm()/prompt() boxes:
// centered card, dimmed backdrop, Esc or a click outside cancels, focus stays inside.
import { renderCategoryEditor } from "./categories.js";
import { currencyName, currencyPicker } from "./currency.js";
import { api, el, toast } from "./lib.js";

const dlg = document.getElementById("dialog");

dlg.addEventListener("click", (e) => {
  // A click on the backdrop (the dialog element itself, outside the card) cancels.
  if (e.target === dlg) dlg.close("cancel");
});

function open(content, { onClose, wide = false } = {}) {
  dlg.classList.toggle("wide", wide);
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

const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);

/** Personal API token for MCP clients and scripts: created here, shown once. */
export function apiTokenDialog(current) {
  const status = el(
    "p",
    { class: "dialog-text" },
    current
      ? `You have a token, created ${shortDate(current.created_at)}${current.last_used_at ? `, last used ${shortDate(current.last_used_at)}` : ", not used yet"}.`
      : "You don't have a token yet.",
  );
  const result = el("div", { class: "token-box", hidden: true });
  const create = el("button", { type: "button" }, current ? "Create a new one" : "Create token");
  const revoke = el("button", { type: "button", class: "ghost", hidden: !current }, "Revoke");
  const close = el("button", { type: "button", class: "ghost" }, "Close");
  close.addEventListener("click", () => dlg.close("cancel"));

  create.addEventListener("click", async () => {
    create.disabled = true;
    try {
      const r = await api("/api/auth/token", { method: "POST", body: {} });
      const input = el("input", { type: "text", readonly: true, value: r.token, "aria-label": "Your API token", spellcheck: "false" });
      const copy = el("button", { type: "button", class: "small" }, "Copy");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(r.token);
          copy.textContent = "Copied";
        } catch {
          input.select();
        }
      });
      result.replaceChildren(el("div", { class: "token-row" }, input, copy), el("small", {}, r.message));
      result.hidden = false;
      status.textContent = "Your new token (any older one stopped working):";
      create.hidden = true;
      revoke.hidden = false;
      input.select();
    } catch (err) {
      toast(err.message);
      create.disabled = false;
    }
  });
  revoke.addEventListener("click", async () => {
    try {
      await api("/api/auth/token", { method: "DELETE" });
      dlg.close("ok");
      toast("API token revoked.", "ok");
    } catch (err) {
      toast(err.message);
    }
  });

  open(
    el(
      "div",
      { class: "dialog-card" },
      icon("lock"),
      el("h2", { class: "dialog-title" }, "API token (MCP)"),
      el("p", { class: "dialog-text" }, "Lets MCP clients like Claude Desktop or Claude Code, and your own scripts, use your account. Treat it like a password."),
      status,
      result,
      el("div", { class: "dialog-actions" }, close, revoke, create),
    ),
  );
  create.focus();
}

/** Deletes the account and all its data, after the password. */
export function deleteAccountDialog() {
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  const submit = el("button", { type: "submit", class: "btn-danger" }, "Delete my account");
  const cancel = el("button", { type: "button", class: "ghost" }, "Cancel");
  const user = el("input", { type: "text", name: "username", autocomplete: "username", value: document.body.dataset.username ?? "", hidden: true, tabindex: "-1" });
  const form = el(
    "form",
    { class: "dialog-card", novalidate: true },
    icon("danger"),
    el("h2", { class: "dialog-title" }, "Delete your account?"),
    el("p", { class: "dialog-text" }, "This permanently deletes your account and all of your expenses, budgets and history. It can't be undone."),
    user,
    field("Your password", { type: "password", name: "password", autocomplete: "current-password", required: true }),
    error,
    el("div", { class: "dialog-actions" }, cancel, submit),
  );
  cancel.addEventListener("click", () => dlg.close("cancel"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = new FormData(form).get("password");
    if (!password) {
      error.textContent = "Enter your password.";
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      await api("/api/auth/delete", { method: "POST", body: { password } });
      try { localStorage.removeItem("expenseagent.known"); } catch { /* fine */ }
      location.replace(location.pathname);
      location.reload();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
    }
  });
  open(form);
  cancel.focus();
}

/** "Edit categories" on the Budget card: the same editor as the first-time setup. */
export function categoriesDialog(payload, onSaved) {
  const editor = el("div", { class: "cat-editor" });
  open(
    el(
      "div",
      { class: "dialog-card" },
      el("h2", { class: "dialog-title" }, "Your categories"),
      el("p", { class: "dialog-text" }, `Up to ${payload.max} categories plus Other, each with a monthly budget. Removing a category you've used keeps its past spending in your history.`),
      editor,
    ),
    { wide: true },
  );
  renderCategoryEditor(editor, payload, {
    submitLabel: "Save",
    onCancel: () => dlg.close("cancel"),
    onSaved: (saved) => {
      dlg.close("ok");
      onSaved(saved);
    },
  });
}

/** Change the account currency (D45). Amounts are relabelled, never converted. */
export function currencyDialog(current, onSaved) {
  let picked = current;
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  const save = el("button", { type: "submit" }, "Save");
  const cancel = el("button", { type: "button", class: "ghost" }, "Cancel");
  const note = el("p", { class: "muted small cur-note", hidden: true });
  const picker = currencyPicker(current, (c) => {
    picked = c;
    error.hidden = true;
    note.hidden = !c || c === current;
    if (c) note.textContent = `Amounts aren't converted: what you recorded in ${current} will show as ${c}.`;
  });
  const form = el(
    "form",
    { class: "dialog-card", novalidate: true },
    icon("info"),
    el("h2", { class: "dialog-title" }, "Currency"),
    el("p", { class: "dialog-text" }, `Budgets and totals are in ${current} (${currencyName(current)}). You can still log an expense in another currency by naming it, like "taxi 20 ${current === "USD" ? "EUR" : "USD"}"; it's kept but not added to your totals.`),
    picker,
    note,
    error,
    el("div", { class: "dialog-actions" }, cancel, save),
  );
  cancel.addEventListener("click", () => dlg.close("cancel"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    if (!picked) return fail("Pick a currency, or type a valid 3-letter code like USD.");
    if (picked === current) return dlg.close("cancel");
    save.disabled = true;
    try {
      const r = await api("/api/settings", { method: "PUT", body: { currency: picked } });
      dlg.close("ok");
      onSaved(r.currency);
    } catch (err) {
      fail(err.message);
    } finally {
      save.disabled = false;
    }
  });
  open(form);
  form.querySelector("select").focus();
}

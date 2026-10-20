// ExpenseAgent MVP UI. Plain JS, no build step. All text goes in via
// textContent, never innerHTML, so nothing typed can inject markup.

const $ = (sel) => document.querySelector(sel);
const logEl = $("#log");
const form = $("#chat-form");
const input = $("#msg");
const sendBtn = $("#send");
const monthInput = $("#month");

const TOKEN_KEY = "expenseagent.token";
const history = []; // last few text turns, sent with each message for follow-ups
let categories = [];

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : String(c));
  return node;
}

const fmt = (n) => (n === null || n === undefined ? "-" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const catName = (key) => categories.find((c) => c.key === key)?.display_name ?? key;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode: token lives for this page only */ }
  memToken = t;
}
let memToken = getToken();

async function api(path, { method = "GET", body, retry = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (memToken) headers.authorization = `Bearer ${memToken}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    // One automatic retry on network failure. Writes carry a request_id, so a retry can't double-save.
    if (retry) return api(path, { method, body, retry: false });
    throw new Error("Network error. Check your connection and try again.");
  }
  if (res.status === 401) {
    const t = window.prompt("Enter your ExpenseAgent access token:");
    if (t) {
      setToken(t.trim());
      return api(path, { method, body, retry });
    }
    throw new Error("Not authorized.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error === "invalid request" || data.error === "invalid arguments" ? "Invalid input." : data.error;
    throw new Error(Array.isArray(data.errors) ? data.errors.join("; ") : msg || `Request failed (${res.status})`);
  }
  return data;
}

function scrollLog() {
  logEl.scrollTop = logEl.scrollHeight;
}

function addBubble(cls, text) {
  const b = el("div", { class: `msg ${cls}` }, text);
  logEl.append(b);
  scrollLog();
  return b;
}

// ---------- chat ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  $(".hint")?.remove();
  addBubble("user", message);
  const typing = addBubble("bot typing", "…");
  sendBtn.disabled = true;

  const request_id = newId();
  try {
    const res = await api("/chat", { method: "POST", body: { message, request_id, history: history.slice(-10) } });
    typing.remove();
    renderReply(res);
    history.push({ role: "user", content: message }, { role: "assistant", content: res.reply });
    if (res.changed) refreshAll();
  } catch (err) {
    typing.remove();
    addBubble("bot error", err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

function renderReply(res) {
  const bubble = addBubble(res.error ? "bot error" : "bot", res.reply);

  if (res.status_lines?.length) {
    bubble.append(el("ul", { class: "status" }, res.status_lines.map((l) => el("li", {}, l))));
  }
  if (res.saved?.length) {
    const undoBtn = el("button", { class: "ghost small", type: "button" }, "Undo");
    undoBtn.addEventListener("click", () => toggleUndo(res.request_id, undoBtn));
    bubble.append(el("div", { class: "row-actions" }, undoBtn));
  }
  if (res.pending) renderPending(bubble, res.pending);
  scrollLog();
}

async function toggleUndo(requestId, btn) {
  btn.disabled = true;
  try {
    const r = await api("/api/undo", { method: "POST", body: { request_id: requestId } });
    btn.textContent = r.action === "removed" ? "Redo" : "Undo";
    refreshAll();
  } catch (err) {
    addBubble("bot error", err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderPending(bubble, pending) {
  const box = el(
    "div",
    { class: "pending" },
    el("strong", {}, "Needs confirmation:"),
    el(
      "ul",
      {},
      pending.items.map((it) =>
        el("li", {}, `${it.note} ${fmt(it.amount)} ${it.currency} · ${catName(it.category)} · ${it.expense_date}`, el("span", { class: "muted" }, ` (${it.reasons.join("; ")})`)),
      ),
    ),
  );
  const confirmBtn = el("button", { type: "button", class: "small" }, "Confirm");
  const cancelBtn = el("button", { type: "button", class: "ghost small" }, "Cancel");
  const actions = el("div", { class: "row-actions" }, confirmBtn, cancelBtn);
  box.append(actions);
  bubble.append(box);

  cancelBtn.addEventListener("click", () => {
    actions.replaceChildren(el("span", { class: "muted" }, "Cancelled. Nothing saved."));
  });
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = cancelBtn.disabled = true;
    try {
      const items = pending.items.map(({ amount, currency, category, note, date_token }) => ({ amount, currency, category, note, date_token }));
      const r = await api("/api/expenses", { method: "POST", body: { request_id: pending.request_id, items, confirmed: true } });
      const undoBtn = el("button", { class: "ghost small", type: "button" }, "Undo");
      undoBtn.addEventListener("click", () => toggleUndo(pending.request_id, undoBtn));
      actions.replaceChildren(el("ul", { class: "status" }, r.status_lines.map((l) => el("li", {}, l))), undoBtn);
      refreshAll();
    } catch (err) {
      confirmBtn.disabled = cancelBtn.disabled = false;
      addBubble("bot error", err.message);
    }
  });
}

// ---------- budget table ----------
async function loadBudget() {
  const month = monthInput.value;
  const s = await api(`/api/budget-status?month=${encodeURIComponent(month)}`);
  const tbody = $("#budget tbody");
  const tfoot = $("#budget tfoot");
  tbody.replaceChildren();
  tfoot.replaceChildren();

  for (const r of s.rows) {
    const pct = r.pct_used;
    const color = pct === null ? null : pct > 100 ? "r" : pct >= 80 ? "a" : "g";
    const budgetCell = el("td", { class: "num" });
    const budgetLabel = el("span", { class: "budget-cell", title: "Click to set budget", tabindex: "0", role: "button" }, r.budget === null ? "set" : fmt(r.budget));
    const startEdit = () => editBudget(budgetCell, r);
    budgetLabel.addEventListener("click", startEdit);
    budgetLabel.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEdit(); } });
    budgetCell.append(budgetLabel);

    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, r.display_name, r.budget === null ? el("span", { class: "tag hide-sm" }, "unbudgeted") : null),
        budgetCell,
        el("td", { class: "num" }, s.has_data || r.spent ? fmt(r.spent) : "-"),
        el("td", { class: `num ${r.remaining !== null && r.remaining < 0 ? "neg" : ""}` }, r.remaining === null ? "-" : r.remaining < 0 ? `(${fmt(-r.remaining)})` : fmt(r.remaining)),
        el("td", { class: "num hide-sm" }, fmt(r.prev_spent)),
        el(
          "td",
          { class: "num" },
          pct === null ? "-" : `${pct}%`,
          color ? el("div", { class: "bar" }, el("span", { class: color, style: `width:${Math.min(pct, 100)}%` })) : null,
        ),
      ),
    );
  }

  const t = s.total;
  tfoot.append(
    el(
      "tr",
      {},
      el("td", {}, "TOTAL"),
      el("td", { class: "num" }, fmt(t.budget)),
      el("td", { class: "num" }, fmt(t.spent)),
      el("td", { class: `num ${t.remaining < 0 ? "neg" : ""}` }, t.remaining < 0 ? `(${fmt(-t.remaining)})` : fmt(t.remaining)),
      el("td", { class: "num hide-sm" }, fmt(t.prev_spent)),
      el("td", { class: "num" }, t.pct_used === null ? "-" : `${t.pct_used}%`),
    ),
  );
  if (t.unbudgeted_spent > 0) {
    tfoot.append(
      el("tr", { class: "sub" }, el("td", { colspan: "2" }, "of which unbudgeted"), el("td", { class: "num" }, fmt(t.unbudgeted_spent)), el("td", { colspan: "3" })),
    );
  }

  const notes = [];
  if (!s.has_data) notes.push("No records for this month yet.");
  if (s.needs_review_count) notes.push(`${s.needs_review_count} expense(s) filed as Other need review.`);
  for (const oc of s.other_currencies) notes.push(`Also ${fmt(oc.total)} ${oc.currency} (not converted, not in totals).`);
  notes.push("% Used total covers budgeted categories only.");
  $("#budget-note").textContent = notes.join(" ");
}

function editBudget(cell, row) {
  const inputEl = el("input", { class: "budget-input", type: "number", min: "0", step: "1", value: row.budget ?? "", "aria-label": `Budget for ${row.display_name}`, placeholder: "none" });
  cell.replaceChildren(inputEl);
  inputEl.focus();
  inputEl.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const raw = inputEl.value.trim();
    const amount = raw === "" ? null : Number(raw);
    if (amount !== row.budget && (amount === null || (Number.isFinite(amount) && amount >= 0))) {
      try {
        await api("/api/budgets", { method: "PUT", body: { category: row.category, amount, month: monthInput.value, apply_forward: true } });
      } catch (err) {
        addBubble("bot error", err.message);
      }
    }
    loadBudget();
  };
  inputEl.addEventListener("blur", commit);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") inputEl.blur();
    if (e.key === "Escape") { done = true; loadBudget(); }
  });
}

// ---------- recent expenses ----------
async function loadRecent() {
  const rows = await api("/api/expenses/recent?limit=25");
  const tbody = $("#recent tbody");
  tbody.replaceChildren(...rows.map(recentRow));
  $("#recent-empty").hidden = rows.length > 0;
}

function recentRow(r) {
  const edit = el("button", { class: "icon-btn", type: "button", title: "Edit", "aria-label": `Edit ${r.note}` }, "Edit");
  const del = el("button", { class: "icon-btn", type: "button", title: "Delete", "aria-label": `Delete ${r.note}` }, "✕");
  const tr = el(
    "tr",
    {},
    el("td", {}, r.expense_date),
    el("td", {}, r.note),
    el("td", {}, catName(r.category), r.needs_review ? el("span", { class: "tag review" }, "review") : null),
    el("td", { class: "num" }, `${fmt(r.amount)}${r.currency !== "EGP" ? " " + r.currency : ""}`),
    el("td", { class: "actions" }, edit, del),
  );
  edit.addEventListener("click", () => startEdit(tr, r));
  del.addEventListener("click", async () => {
    if (!window.confirm(`Delete "${r.note} ${fmt(r.amount)}"?`)) return;
    try {
      await api(`/api/expenses/${r.id}`, { method: "DELETE" });
      refreshAll();
    } catch (err) {
      addBubble("bot error", err.message);
    }
  });
  return tr;
}

function startEdit(tr, r) {
  const row = $("#tpl-edit").content.firstElementChild.cloneNode(true);
  row.querySelector("[name=date]").value = r.expense_date;
  row.querySelector("[name=note]").value = r.note;
  row.querySelector("[name=amount]").value = r.amount;
  const sel = row.querySelector("[name=category]");
  for (const c of categories) sel.append(el("option", { value: c.key, selected: c.key === r.category }, c.display_name));
  tr.replaceWith(row);
  row.querySelector("[name=amount]").focus();

  row.querySelector("[data-act=cancel]").addEventListener("click", () => row.replaceWith(recentRow(r)));
  row.querySelector("[data-act=save]").addEventListener("click", async () => {
    const fields = {
      amount: Number(row.querySelector("[name=amount]").value),
      note: row.querySelector("[name=note]").value.trim(),
      category: sel.value,
      date_token: `date:${row.querySelector("[name=date]").value}`,
    };
    try {
      await api(`/api/expenses/${r.id}`, { method: "PATCH", body: { fields } });
      refreshAll();
    } catch (err) {
      addBubble("bot error", err.message);
    }
  });
}

// ---------- boot ----------
function refreshAll() {
  return Promise.all([loadBudget(), loadRecent()]).catch((err) => addBubble("bot error", err.message));
}

function cairoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function boot() {
  const today = cairoToday();
  $("#today").textContent = today;
  monthInput.value = today.slice(0, 7);
  monthInput.max = today.slice(0, 7);
  monthInput.addEventListener("change", () => loadBudget().catch((err) => addBubble("bot error", err.message)));
  try {
    categories = await api("/api/categories");
  } catch (err) {
    addBubble("bot error", err.message);
    return;
  }
  await refreshAll();
  input.focus();
}

boot();

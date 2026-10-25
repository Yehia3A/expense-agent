// Track view: chat, budget table for one month, recent expenses.
import { $, api, localToday, catName, dataChanged, el, expenseRow, fmt, newId, toast } from "./lib.js";

const logEl = $("#log");
const form = $("#chat-form");
const input = $("#msg");
const sendBtn = $("#send");
const monthInput = $("#month");
const history = []; // last few text turns, sent with each message for follow-ups

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
/**
 * Send one message through /chat and show it in the log. Returns the reply,
 * or throws. Used by the message box and by driving mode.
 */
export async function sendChat(message) {
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
    if (res.changed) dataChanged();
    return res;
  } catch (err) {
    typing.remove();
    addBubble("bot error", err.message);
    throw err;
  } finally {
    sendBtn.disabled = false;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  try {
    await sendChat(message);
  } catch {
    /* already shown in the log */
  }
  input.focus();
});

function renderReply(res) {
  const bubble = addBubble(res.error ? "bot error" : "bot", res.reply);
  if (res.status_lines?.length) {
    bubble.append(el("ul", { class: "status" }, res.status_lines.map((l) => el("li", {}, l))));
  }
  if (res.saved?.length) bubble.append(el("div", { class: "row-actions" }, undoButton(res.request_id)));
  if (res.pending) renderPending(bubble, res.pending);
  scrollLog();
}

function undoButton(requestId) {
  const btn = el("button", { class: "ghost small", type: "button" }, "Undo");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const r = await api("/api/undo", { method: "POST", body: { request_id: requestId } });
      btn.textContent = r.action === "removed" ? "Redo" : "Undo";
      dataChanged();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
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
      actions.replaceChildren(el("ul", { class: "status" }, r.status_lines.map((l) => el("li", {}, l))), undoButton(pending.request_id));
      dataChanged();
    } catch (err) {
      confirmBtn.disabled = cancelBtn.disabled = false;
      toast(err.message);
    }
  });
}

// ---------- budget table ----------
/** Budget table rows (plan 10.1). `editable` adds click-to-set budgets. Shared with History. */
export function renderBudgetTable(table, s, { editable = false, onEdit } = {}) {
  const tbody = table.tBodies[0];
  const tfoot = table.tFoot;
  tbody.replaceChildren();
  tfoot.replaceChildren();

  for (const r of s.rows) {
    const pct = r.pct_used;
    const color = pct === null ? null : pct > 100 ? "r" : pct >= 80 ? "a" : "g";
    const budgetCell = el("td", { class: "num" });
    if (editable) {
      const label = el("span", { class: "budget-cell", title: "Click to set budget", tabindex: "0", role: "button" }, r.budget === null ? "set" : fmt(r.budget));
      const start = () => onEdit(budgetCell, r);
      label.addEventListener("click", start);
      label.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); }
      });
      budgetCell.append(label);
    } else {
      budgetCell.append(fmt(r.budget));
    }
    const remaining = r.remaining === null ? "-" : r.remaining < 0 ? `(${fmt(-r.remaining)})` : fmt(r.remaining);
    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, r.display_name, r.budget === null ? el("span", { class: "tag hide-sm" }, "unbudgeted") : null),
        budgetCell,
        el("td", { class: "num" }, s.has_data || r.spent ? fmt(r.spent) : "-"),
        el("td", { class: `num ${r.remaining !== null && r.remaining < 0 ? "neg" : ""}` }, remaining),
        el("td", { class: "num hide-sm" }, fmt(r.prev_spent)),
        el(
          "td",
          { class: "num" },
          pct === null ? "-" : `${pct}%`,
          color ? el("div", { class: "bar", "aria-hidden": "true" }, el("span", { class: color, style: { width: `${Math.min(pct, 100)}%` } })) : null,
        ),
      ),
    );
  }

  const t = s.total;
  tfoot.append(
    el(
      "tr",
      {},
      el("td", {}, s.currency ? `TOTAL (${s.currency})` : "TOTAL"),
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
  if (!s.has_data) notes.push("No records for this month.");
  if (s.legacy_total) notes.push(`Includes ${fmt(s.legacy_total)} imported from Excel.`);
  if (s.needs_review_count) notes.push(`${s.needs_review_count} expense(s) in Other need review.`);
  for (const oc of s.other_currencies) notes.push(`Also ${fmt(oc.total)} ${oc.currency} (not converted, not in totals).`);
  notes.push("% Used total covers budgeted categories only.");
  return notes.join(" ");
}

async function loadBudget() {
  const s = await api(`/api/budget-status?month=${encodeURIComponent(monthInput.value)}`);
  $("#budget-note").textContent = renderBudgetTable($("#budget"), s, { editable: true, onEdit: editBudget });
}

function editBudget(cell, row) {
  const inputEl = el("input", {
    class: "budget-input",
    type: "number",
    min: "0",
    step: "1",
    value: row.budget ?? "",
    "aria-label": `Budget for ${row.display_name}`,
    placeholder: "none",
  });
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
        dataChanged();
        return;
      } catch (err) {
        toast(err.message);
      }
    }
    loadBudget();
  };
  inputEl.addEventListener("blur", commit);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") inputEl.blur();
    if (e.key === "Escape") {
      done = true;
      loadBudget();
    }
  });
}

// ---------- recent expenses ----------
async function loadRecent() {
  const rows = await api("/api/expenses/recent?limit=25");
  $("#recent tbody").replaceChildren(...rows.map(expenseRow));
  $("#recent-empty").hidden = rows.length > 0;
}

export function initTrack() {
  const month = localToday().slice(0, 7);
  monthInput.value = month;
  monthInput.max = month;
  monthInput.addEventListener("change", () => loadBudget().catch((err) => toast(err.message)));
}

// ---------- quick log (D44) ----------
async function loadQuick() {
  const items = await api("/api/quick");
  const box = $("#quick");
  box.replaceChildren(
    ...items.map((it) => {
      const btn = el(
        "button",
        { type: "button", class: "quick-btn", title: `Log ${it.note} ${fmt(it.amount)} in ${it.category_name} again`, "aria-label": `Log ${it.note}, ${fmt(it.amount)}, again` },
        el("span", { class: "quick-note" }, it.note),
        el("span", { class: "quick-amt" }, fmt(it.amount)),
      );
      btn.addEventListener("click", () => quickLog(it, btn));
      return btn;
    }),
  );
  box.hidden = items.length === 0;
}

/** One tap: save the item again with its usual amount and category, no AI involved. */
async function quickLog(it, btn) {
  btn.disabled = true;
  $(".hint")?.remove();
  addBubble("user", `${it.note} ${it.amount}`);
  const request_id = newId();
  try {
    const r = await api("/api/expenses", {
      method: "POST",
      body: { request_id, items: [{ note: it.note, amount: it.amount, category: it.category }] },
    });
    renderReply({
      request_id,
      reply: r.status === "saved" ? "Saved." : "That needs confirmation: press Confirm to save it.",
      saved: r.saved ?? [],
      status_lines: r.status_lines ?? [],
      pending:
        r.status === "needs_confirmation"
          ? { request_id: `${request_id}:confirm`, items: r.items.map((i) => ({ ...i, date_token: `date:${i.expense_date}` })) }
          : null,
    });
    if (r.status === "saved") dataChanged();
  } catch (err) {
    addBubble("bot error", err.message);
  } finally {
    btn.disabled = false;
  }
}

export function loadTrack() {
  return Promise.all([loadBudget(), loadRecent(), loadQuick()]);
}

export const focusChat = () => input.focus();

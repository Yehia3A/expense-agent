import { confirmDialog } from "./dialog.js";
// Shared UI helpers. All text goes in via textContent, never innerHTML, so
// nothing typed can inject markup.

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v); // CSSOM, allowed by the CSP (attributes are not)
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : String(c));
  return node;
}

export const fmt = (n) => (n === null || n === undefined ? "-" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
/** Amount with its code shown only when it isn't the account currency (D45). */
export const money = (n, currency) => `${fmt(n)}${currency && currency !== state.currency ? " " + currency : ""}`;
export const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

/** Today as YYYY-MM-DD in the account's time zone (D46). */
export function localToday() {
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: state.timezone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: "Africa/Cairo" }).format(new Date());
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (m, long = false) => {
  const [y, mm] = m.split("-");
  const name = long ? new Date(Date.UTC(+y, +mm - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }) : MONTHS[+mm - 1];
  return `${name} ${y}`;
};
export const lastDayOf = (m) => {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
};

// ---------- shared state ----------
export const state = { categories: [], currency: "EGP", timezone: "Africa/Cairo" };
export const catName = (key) => state.categories.find((c) => c.key === key)?.display_name ?? key;

const listeners = new Set();
/** Views subscribe to be told that expenses or budgets changed somewhere. */
export const onDataChanged = (fn) => listeners.add(fn);
export const dataChanged = () => listeners.forEach((fn) => fn());

// ---------- notices ----------
/** A short notice at the bottom of the screen: "error" (default) or "ok". */
export function toast(message, kind = "error") {
  const box = $("#toast");
  const item = el("div", { class: `toast-item ${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  box.append(item);
  setTimeout(() => item.classList.add("leaving"), 5200);
  setTimeout(() => item.remove(), 5600);
}

// ---------- theme ----------
const THEME_KEY = "expenseagent.theme";
export const currentTheme = () => document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
export function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* not remembered, still applied */ }
  for (const b of document.querySelectorAll(".theme-toggle")) {
    b.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    b.setAttribute("title", theme === "dark" ? "Light mode" : "Dark mode");
  }
  window.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}
export function wireThemeToggles() {
  for (const b of document.querySelectorAll(".theme-toggle")) {
    b.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  }
  setTheme(currentTheme());
}

// ---------- API ----------
// The browser session is an HttpOnly cookie, sent automatically; a 401 means it ended.
export async function api(path, { method = "GET", body, retry = true } = {}) {
  const headers = { "content-type": "application/json" };
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    // One automatic retry on network failure. Writes carry a request_id, so a retry can't double-save.
    if (retry) return api(path, { method, body, retry: false });
    throw new Error("Network error. Check your connection and try again.");
  }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("auth:required"));
    throw new Error("Your session has ended. Please sign in again.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("Too many requests. Wait a minute and try again.");
  if (!res.ok) {
    const msg = data.error === "invalid request" || data.error === "invalid arguments" ? "Invalid input." : data.error;
    throw new Error(Array.isArray(data.errors) ? data.errors.join("; ") : msg || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- editable expense rows (Track, History, Review) ----------
/** A table row with Edit and Delete. Columns: date, item, category, amount, actions. */
export function expenseRow(r) {
  const edit = el("button", { class: "icon-btn", type: "button", title: "Edit", "aria-label": `Edit ${r.note}` }, "Edit");
  const del = el("button", { class: "icon-btn", type: "button", title: "Delete", "aria-label": `Delete ${r.note}` }, "✕");
  const tr = el(
    "tr",
    {},
    el("td", { class: "nowrap" }, r.expense_date),
    el("td", {}, r.note),
    el("td", {}, catName(r.category), r.needs_review ? el("span", { class: "tag review" }, "review") : null),
    el("td", { class: "num" }, money(r.amount, r.currency)),
    el("td", { class: "actions" }, edit, del),
  );
  edit.addEventListener("click", () => startEdit(tr, r));
  del.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete this expense?",
      message: `${r.note} · ${money(r.amount, r.currency)} · ${r.expense_date}. It will be removed from your totals.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/expenses/${r.id}`, { method: "DELETE" });
      toast(`Deleted ${r.note}.`, "ok");
      dataChanged();
    } catch (err) {
      toast(err.message);
    }
  });
  return tr;
}

function startEdit(tr, r) {
  const row = $("#tpl-edit").content.firstElementChild.cloneNode(true);
  row.querySelector("[name=date]").value = r.expense_date;
  row.querySelector("[name=date]").max = localToday();
  row.querySelector("[name=note]").value = r.note;
  row.querySelector("[name=amount]").value = r.amount;
  row.querySelector("[name=details]").value = r.details ?? "";
  const sel = row.querySelector("[name=category]");
  for (const c of state.categories) sel.append(el("option", { value: c.key, selected: c.key === r.category }, c.display_name));
  tr.replaceWith(row);
  row.querySelector("[name=amount]").focus();

  row.querySelector("[data-act=cancel]").addEventListener("click", () => row.replaceWith(expenseRow(r)));
  row.querySelector("[data-act=save]").addEventListener("click", async () => {
    const fields = {
      amount: Number(row.querySelector("[name=amount]").value),
      note: row.querySelector("[name=note]").value.trim(),
      category: sel.value,
      date_token: `date:${row.querySelector("[name=date]").value}`,
      details: row.querySelector("[name=details]").value.trim() || null,
    };
    try {
      await api(`/api/expenses/${r.id}`, { method: "PATCH", body: { fields } });
      dataChanged();
    } catch (err) {
      toast(err.message);
    }
  });
}

/** <option>s for a month <select>: every month with data plus the current month, newest first. */
export function fillMonthSelect(select, months, selected) {
  const current = localToday().slice(0, 7);
  const all = [...new Set([current, ...months])].filter((m) => m <= current).sort().reverse();
  select.replaceChildren(...all.map((m) => el("option", { value: m, selected: m === selected }, monthLabel(m, true))));
  if (!all.includes(selected)) select.value = all[0];
  return select.value;
}

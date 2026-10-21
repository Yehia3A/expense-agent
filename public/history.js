// History view (plan 10.2): trailing 12-month table, then one month's
// remaining-by-category (its own budgets) and its transactions.
import { $, api, cairoToday, el, expenseRow, fillMonthSelect, fmt, lastDayOf, monthLabel, state } from "./lib.js";
import { renderBudgetTable } from "./track.js";

const select = $("#hist-month");

function renderTable(h) {
  const table = $("#hist-table");
  const cats = h.categories;
  table.tHead.replaceChildren(
    el("tr", {}, el("th", { class: "sticky" }, "Month"), cats.map((c) => el("th", { class: "num" }, c.display_name)), el("th", { class: "num" }, "Total")),
  );
  table.tBodies[0].replaceChildren(
    ...h.rows.map((r) => {
      const tr = el(
        "tr",
        { class: `clickable ${r.month === select.value ? "selected" : ""}`, tabindex: "0", "aria-label": `Show ${monthLabel(r.month, true)}` },
        el("th", { class: "sticky", scope: "row" }, monthLabel(r.month), r.has_legacy ? el("span", { class: "tag", title: "Imported from Excel" }, "xls") : null),
        cats.map((c) => el("td", { class: "num" }, r.has_data ? fmt(r.by_category[c.key]) : "-")),
        el("td", { class: "num strong" }, r.has_data ? fmt(r.total) : "-"),
      );
      if (r.has_data) {
        const pick = () => {
          select.value = r.month;
          loadMonth();
          renderTable(h);
          $("#hist-detail").scrollIntoView({ behavior: "smooth", block: "start" });
        };
        tr.addEventListener("click", pick);
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter") pick();
        });
      } else {
        tr.classList.remove("clickable");
        tr.removeAttribute("tabindex");
      }
      return tr;
    }),
  );
  table.tFoot.replaceChildren(
    el("tr", {}, el("th", { class: "sticky" }, "Total"), cats.map((c) => el("td", { class: "num" }, fmt(h.category_totals[c.key]))), el("td", { class: "num" }, fmt(h.total))),
    el("tr", { class: "sub" }, el("th", { class: "sticky" }, "Monthly avg"), cats.map(() => el("td")), el("td", { class: "num" }, fmt(h.monthly_average))),
  );
}

async function loadMonth() {
  const month = select.value;
  const [status, list] = await Promise.all([
    api(`/api/budget-status?month=${encodeURIComponent(month)}`),
    api(`/api/expenses?start_date=${month}-01&end_date=${lastDayOf(month)}&limit=500`),
  ]);
  $("#hist-month-title").textContent = monthLabel(month, true);
  $("#hist-budget-note").textContent = renderBudgetTable($("#hist-budget"), status);

  const rows = list.expenses;
  $("#hist-tx tbody").replaceChildren(...rows.map(expenseRow));
  const txTotal = rows.filter((r) => r.currency === state.currency).reduce((s, r) => s + r.amount, 0);
  $("#hist-tx tfoot").replaceChildren(
    el("tr", {}, el("td", { colspan: "3" }, `Total (${rows.length} transaction${rows.length === 1 ? "" : "s"})`), el("td", { class: "num" }, fmt(Math.round(txTotal * 100) / 100)), el("td")),
  );
  const notes = [];
  if (!rows.length) notes.push(status.legacy_total ? "This month only has totals imported from Excel; there are no transaction rows." : "No transactions this month.");
  else if (status.legacy_total) notes.push(`Plus ${fmt(status.legacy_total)} imported from Excel as category totals (no transaction rows).`);
  $("#hist-tx-note").textContent = notes.join(" ");
}

export async function loadHistory() {
  const h = await api("/api/history?months=12");
  fillMonthSelect(select, h.months_with_data, select.value || cairoToday().slice(0, 7));
  renderTable(h);
  await loadMonth();
}

export function initHistory() {
  select.addEventListener("change", () => loadHistory());
}

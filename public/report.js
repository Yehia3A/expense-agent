// Report view (plan 10.3): totals vs last month, category breakdown, daily
// trend, top expenses and items, projection, needs-review list.
import { barChart } from "./charts.js";
import { $, api, cairoToday, catName, el, expenseRow, fillMonthSelect, fmt, money, monthLabel } from "./lib.js";

const select = $("#report-month");
let last = null; // last report, for re-drawing charts on theme change

function tile(label, value, sub) {
  return el("div", { class: "tile" }, el("div", { class: "tile-label" }, label), el("div", { class: "tile-value" }, value), sub ? el("div", { class: "tile-sub" }, sub) : null);
}

function changeText(r) {
  if (r.prev_total === 0) return `No spending recorded in ${monthLabel(prevMonth(r.month))}`;
  const sign = r.change > 0 ? "+" : r.change < 0 ? "−" : "±";
  return `${sign}${fmt(Math.abs(r.change))} (${sign}${fmt(Math.abs(r.change_pct))}%) vs ${monthLabel(prevMonth(r.month))}`;
}

function prevMonth(m) {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7);
}

function smallTable(headers, rows) {
  return el(
    "table",
    { class: "grid" },
    el("thead", {}, el("tr", {}, headers.map(([h, cls]) => el("th", { class: cls ?? "" }, h)))),
    el("tbody", {}, rows),
  );
}

function render(r) {
  last = r;
  const tiles = [
    tile("Total spent", fmt(r.total), changeText(r)),
    tile("Average per day", fmt(r.avg_per_day), `${r.days_elapsed} day${r.days_elapsed === 1 ? "" : "s"}${r.is_current ? " so far" : ""}`),
    tile("Highest day", r.highest_day ? fmt(r.highest_day.total) : "-", r.highest_day ? r.highest_day.date : "No transactions"),
  ];
  if (r.projection) {
    const p = r.projection;
    tiles.push(tile("Projected month-end", fmt(p.projected_total), p.projected_pct_of_budget === null ? "No budget set" : `${fmt(p.projected_pct_of_budget)}% of ${fmt(p.budget)} budget`));
  }
  $("#report-tiles").replaceChildren(...tiles);

  const notes = [];
  if (!r.has_data) notes.push("No records for this month.");
  if (r.legacy_total) notes.push(`Includes ${fmt(r.legacy_total)} imported from Excel as monthly totals; those have no daily or item detail.`);
  for (const oc of r.other_currencies) notes.push(`Also ${fmt(oc.total)} ${oc.currency}, not converted and not in these totals.`);
  $("#report-note").textContent = notes.join(" ");

  // Category breakdown: chart + table (the table is the accessible view).
  const cats = r.by_category.filter((c) => c.total > 0);
  $("#chart-cats-box").style.height = `${Math.max(120, cats.length * 34 + 30)}px`;
  barChart($("#chart-cats"), { labels: cats.map((c) => c.display_name), values: cats.map((c) => c.total), horizontal: true, title: "Spending by category" });
  $("#report-cats tbody").replaceChildren(
    ...r.by_category.map((c) =>
      el(
        "tr",
        {},
        el("td", {}, c.display_name),
        el("td", { class: "num" }, fmt(c.total)),
        el("td", { class: "num" }, `${fmt(c.share_pct)}%`),
        el("td", { class: "num hide-sm" }, fmt(c.prev_total)),
      ),
    ),
  );
  $("#report-cats-empty").hidden = cats.length > 0;

  // Daily trend.
  barChart($("#chart-daily"), { labels: r.daily.map((d) => d.date.slice(8)), values: r.daily.map((d) => d.total), title: "Daily spending" });
  $("#report-daily tbody").replaceChildren(...r.daily.map((d) => el("tr", {}, el("td", {}, d.date), el("td", { class: "num" }, fmt(d.total)))));
  $("#chart-daily-box").hidden = !r.has_transactions;
  $("#report-daily-empty").hidden = r.has_transactions;

  // Top expenses and items.
  $("#report-top").replaceChildren(
    r.top_expenses.length
      ? smallTable(
          [["Date"], ["Item"], ["Category"], ["Amount", "num"]],
          r.top_expenses.map((e) => el("tr", {}, el("td", { class: "nowrap" }, e.expense_date), el("td", {}, e.note), el("td", {}, catName(e.category)), el("td", { class: "num" }, money(e.amount, e.currency)))),
        )
      : el("p", { class: "muted small" }, "No transactions this month."),
  );
  const itemRows = (list, metric) =>
    list.map((i) => el("tr", {}, el("td", {}, i.item), el("td", { class: "num" }, metric === "count" ? `${i.count}×` : fmt(i.total)), el("td", { class: "num muted" }, metric === "count" ? fmt(i.total) : `${i.count}×`)));
  $("#report-items").replaceChildren(
    r.top_items_by_total.length
      ? el(
          "div",
          { class: "two-col" },
          el("div", {}, el("h4", {}, "By total"), smallTable([["Item"], ["Total", "num"], ["Times", "num"]], itemRows(r.top_items_by_total, "total"))),
          el("div", {}, el("h4", {}, "By frequency"), smallTable([["Item"], ["Times", "num"], ["Total", "num"]], itemRows(r.top_items_by_count, "count"))),
        )
      : el("p", { class: "muted small" }, "No transactions this month."),
  );

  // Needs review: editable rows, so a fix is one click away.
  $("#report-review-card").hidden = r.needs_review.length === 0;
  $("#report-review tbody").replaceChildren(...r.needs_review.map(expenseRow));
}

export async function loadReport() {
  const month = select.value || cairoToday().slice(0, 7);
  render(await api(`/api/report?month=${encodeURIComponent(month)}`));
}

export async function initReport() {
  select.addEventListener("change", () => loadReport());
  window.addEventListener("themechange", () => last && render(last));
}

export async function refreshReportMonths() {
  const h = await api("/api/history?months=1");
  fillMonthSelect(select, h.months_with_data, select.value || cairoToday().slice(0, 7));
}

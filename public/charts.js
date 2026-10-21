// Chart.js wrappers (vendored UMD build in /vendor, loaded as a global).
// Both charts are single-series, so one hue, no legend; the card title names
// the series. Colors come from the page's CSS tokens, so dark mode gets its
// own values. Thin bars with 4px rounded ends anchored to the baseline,
// recessive grid on the value axis only, hover tooltips on every bar.

import { state } from "./lib.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

function base(horizontal) {
  const ink = css("--muted");
  const grid = css("--line");
  const valueAxis = {
    beginAtZero: true,
    grid: { color: grid, drawTicks: false },
    border: { display: false },
    ticks: { color: ink, padding: 6, maxTicksLimit: 5, callback: (v) => fmt(v) },
  };
  const catAxis = { grid: { display: false }, border: { color: grid }, ticks: { color: ink, autoSkip: true, maxRotation: 0 } };
  return {
    indexAxis: horizontal ? "y" : "x",
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css("--card"),
        titleColor: css("--text"),
        bodyColor: css("--text"),
        borderColor: grid,
        borderWidth: 1,
        padding: 8,
        displayColors: false,
        callbacks: { label: (ctx) => `${fmt(horizontal ? ctx.parsed.x : ctx.parsed.y)} ${state.currency}` },
      },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

export function barChart(canvas, { labels, values, horizontal = false, title }) {
  window.Chart?.getChart(canvas)?.destroy();
  if (!window.Chart) return null;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", title);
  return new window.Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: title,
          data: values,
          backgroundColor: css("--accent"),
          hoverBackgroundColor: css("--accent-strong") || css("--accent"),
          borderRadius: 4,
          borderSkipped: "start",
          maxBarThickness: horizontal ? 18 : 22,
          categoryPercentage: 0.8,
          barPercentage: 0.9,
        },
      ],
    },
    options: base(horizontal),
  });
}

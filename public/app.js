// ExpenseAgent UI entry: loads categories, routes between the Track, Report
// and History views (#track, #report, #history) and refreshes whatever is
// visible when data changes.
import { initHistory, loadHistory } from "./history.js";
import { $, api, cairoToday, onDataChanged, state, toast } from "./lib.js";
import { initReport, loadReport, refreshReportMonths } from "./report.js";
import { focusChat, initTrack, loadTrack } from "./track.js";

const VIEWS = {
  track: { load: loadTrack },
  report: { load: async () => { await refreshReportMonths(); await loadReport(); } },
  history: { load: loadHistory },
};
const stale = new Set(Object.keys(VIEWS));

function current() {
  const name = location.hash.replace("#", "");
  return name in VIEWS ? name : "track";
}

async function show() {
  const name = current();
  for (const v of Object.keys(VIEWS)) {
    $(`#view-${v}`).hidden = v !== name;
    const tab = $(`#tab-${v}`);
    if (v === name) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (stale.has(name)) {
    stale.delete(name);
    try {
      await VIEWS[name].load();
    } catch (err) {
      stale.add(name);
      toast(err.message);
    }
  }
  if (name === "track") focusChat();
}

onDataChanged(() => {
  for (const v of Object.keys(VIEWS)) stale.add(v);
  show();
});

async function boot() {
  $("#today").textContent = cairoToday();
  initTrack();
  initReport();
  initHistory();
  try {
    state.categories = await api("/api/categories");
  } catch (err) {
    toast(err.message);
    return;
  }
  window.addEventListener("hashchange", show);
  await show();
}

boot();

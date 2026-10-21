// ExpenseAgent UI entry: checks the session, then shows either the welcome
// screen (sign in / first account) or the app with its Track, Report and
// History views (#track, #report, #history).
import { getMe, showWelcome, signOut } from "./auth.js";
import { renderCategoryEditor } from "./categories.js";
import { guessCurrency } from "./currency.js";
import { apiTokenDialog, categoriesDialog, changePasswordDialog, currencyDialog, deleteAccountDialog } from "./dialog.js";
import { initHistory, loadHistory } from "./history.js";
import { $, api, cairoToday, dataChanged, onDataChanged, state, toast, wireThemeToggles } from "./lib.js";
import { initReport, loadReport, refreshReportMonths } from "./report.js";
import { focusChat, initTrack, loadTrack } from "./track.js";
import { initVoice } from "./drive.js";

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

function wireUserMenu(username) {
  const btn = $("#user-btn");
  const menu = $("#user-menu");
  document.body.dataset.username = username;
  $("#user-name").textContent = username;
  $("#user-initial").textContent = username.slice(0, 1).toUpperCase();
  $("#menu-username").textContent = username;
  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button")?.focus();
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close();
      btn.focus();
    }
  });
  $("#menu-password").addEventListener("click", () => {
    close();
    changePasswordDialog();
  });
  $("#menu-token").addEventListener("click", async () => {
    close();
    const me = await getMe().catch(() => null);
    apiTokenDialog(me?.api_token ?? null);
  });
  $("#menu-currency").addEventListener("click", () => {
    close();
    currencyDialog(state.currency, (c) => {
      state.currency = c;
      toast(`Currency set to ${c}.`, "ok");
      dataChanged();
    });
  });
  $("#menu-signout").addEventListener("click", () => {
    close();
    signOut();
  });
  $("#menu-delete").addEventListener("click", () => {
    close();
    deleteAccountDialog();
  });
}

/** Keep the shared category list (pickers, names in tables) in step with the account's categories. */
function useCategories(payload) {
  state.categories = payload.categories.map((c) => ({ key: c.key, display_name: c.name }));
  if (payload.currency) state.currency = payload.currency;
}

/** First time only: pick categories and budgets before the app opens (D41). */
function runSetup(payload) {
  return new Promise((resolve) => {
    $("#boot").hidden = true;
    $("#welcome").hidden = true;
    $("#app").hidden = true;
    $("#setup").hidden = false;
    // First pick for the currency comes from the device's time zone (D45).
    renderCategoryEditor($("#setup-editor"), { ...payload, initialCurrency: guessCurrency(payload.currency) }, {
      submitLabel: "Start tracking",
      onSaved: (saved) => {
        $("#setup").hidden = true;
        resolve(saved);
      },
    });
  });
}

async function startApp(me) {
  let payload;
  try {
    payload = await api("/api/categories");
  } catch (err) {
    $("#boot-text").textContent = err.message;
    return;
  }
  if (payload.needs_setup) payload = await runSetup(payload);
  useCategories(payload);

  $("#boot").hidden = true;
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  $("#today").textContent = cairoToday();
  wireUserMenu(me.username ?? "you");
  initTrack();
  initReport();
  initHistory();
  initVoice();
  $("#edit-cats").addEventListener("click", async () => {
    try {
      categoriesDialog(await api("/api/categories"), (saved) => {
        useCategories(saved);
        toast("Categories saved.", "ok");
        dataChanged();
      });
    } catch (err) {
      toast(err.message);
    }
  });
  onDataChanged(() => {
    for (const v of Object.keys(VIEWS)) stale.add(v);
    show();
  });
  window.addEventListener("hashchange", show);
  await show();
}

async function boot() {
  wireThemeToggles();
  let me;
  try {
    me = await getMe();
  } catch (err) {
    $("#boot-text").textContent = err.message;
    return;
  }
  // Any API call that finds the session gone sends you back to the sign-in card.
  window.addEventListener("auth:required", async () => {
    const fresh = await getMe().catch(() => ({ authenticated: false }));
    if (!fresh.authenticated) showWelcome(fresh, { message: "Your session has ended. Please sign in again." });
  });
  if (me.authenticated) await startApp(me);
  else showWelcome(me);
}

boot();

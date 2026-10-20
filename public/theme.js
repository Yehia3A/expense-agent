// Runs before the stylesheet paints (a plain script in <head>, allowed by
// the CSP because it is a file): dark by default, light if you chose it.
(function () {
  var theme = "dark";
  try {
    theme = localStorage.getItem("expenseagent.theme") || "dark";
  } catch (e) {
    /* storage blocked: stay dark */
  }
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
})();

// Category editor (D41): pick suggestions or write your own names, up to the
// limit, each with a monthly budget; "Other" is always there. Used by the
// first-time setup screen and by "Edit categories" on the Budget card.
import { api, el, fmt } from "./lib.js";

/**
 * Render the editor into `root`. Resolves nothing; calls onSaved(payload)
 * after a successful save.
 */
export function renderCategoryEditor(root, payload, { submitLabel = "Save", onSaved, onCancel } = {}) {
  const max = payload.max ?? 10;
  // Working copy: [{ key?, name, budget }]
  let items = payload.categories.filter((c) => !c.is_other).map((c) => ({ key: c.key, name: c.name, budget: c.budget }));
  const other = payload.categories.find((c) => c.is_other);
  let otherBudget = other?.budget ?? null;

  const chips = el("div", { class: "chips", role: "group", "aria-label": "Suggested categories" });
  const list = el("div", { class: "cat-list" });
  const count = el("span", { class: "cat-count" });
  const total = el("p", { class: "cat-total" });
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  const addInput = el("input", { type: "text", maxlength: "30", placeholder: "Write your own, e.g. Car or Rent", "aria-label": "New category name" });
  const addBtn = el("button", { type: "submit", class: "small" }, "Add");
  const addForm = el("form", { class: "cat-add" }, addInput, addBtn);
  const save = el("button", { type: "button", class: "btn-block" }, el("span", { class: "btn-label" }, submitLabel));
  const otherBudgetInput = budgetInput(otherBudget, "Budget for Other", (v) => {
    otherBudget = v;
    updateTotal();
  });

  const norm = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const has = (name) => items.some((i) => norm(i.name) === norm(name));

  function budgetInput(value, label, onChange) {
    const input = el("input", {
      type: "number",
      inputmode: "numeric",
      min: "0",
      step: "1",
      placeholder: "No budget",
      value: value ?? "",
      "aria-label": label,
      class: "cat-budget",
    });
    input.addEventListener("input", () => onChange(input.value === "" ? null : Math.max(0, Number(input.value))));
    return el("label", { class: "budget-field" }, input, el("span", { class: "unit" }, "EGP / month"));
  }

  function showError(msg) {
    error.textContent = msg;
    error.hidden = !msg;
  }

  function add(name, key) {
    name = name.trim().replace(/\s+/g, " ");
    if (!name) return;
    if (norm(name) === "other") return showError("Other is already included.");
    if (has(name)) return showError(`"${name}" is already in your list.`);
    if (items.length >= max) return showError(`Up to ${max} categories. Remove one first.`);
    showError("");
    items.push({ key, name, budget: null });
    render();
    // Jump straight to its budget.
    list.querySelectorAll(".cat-budget")[items.length - 1]?.focus();
  }

  function updateTotal() {
    const sum = items.reduce((s, i) => s + (i.budget ?? 0), 0) + (otherBudget ?? 0);
    total.textContent = sum > 0 ? `Monthly budget in total: ${fmt(sum)} EGP` : "No budgets yet. You can track spending without them.";
    count.textContent = `${items.length} of ${max}`;
  }

  function render() {
    chips.replaceChildren(
      ...payload.presets.map((p) => {
        const on = has(p.name);
        const chip = el("button", { type: "button", class: `chip ${on ? "on" : ""}`, "aria-pressed": String(on), title: p.hint }, on ? `✓ ${p.name}` : `+ ${p.name}`);
        chip.addEventListener("click", () => {
          if (has(p.name)) {
            items = items.filter((i) => norm(i.name) !== norm(p.name));
            showError("");
            render();
          } else add(p.name, p.key);
        });
        return chip;
      }),
    );
    list.replaceChildren(
      ...items.map((item, idx) => {
        const name = el("input", { type: "text", value: item.name, maxlength: "30", "aria-label": "Category name", class: "cat-name" });
        name.addEventListener("input", () => {
          item.name = name.value;
        });
        name.addEventListener("change", () => render());
        const remove = el("button", { type: "button", class: "icon-btn cat-remove", "aria-label": `Remove ${item.name}`, title: "Remove" }, "✕");
        remove.addEventListener("click", () => {
          items.splice(idx, 1);
          showError("");
          render();
        });
        return el(
          "div",
          { class: "cat-row" },
          name,
          budgetInput(item.budget, `Monthly budget for ${item.name}`, (v) => {
            item.budget = v;
            updateTotal();
          }),
          remove,
        );
      }),
    );
    if (!items.length) list.append(el("p", { class: "muted small cat-empty" }, "Tap suggestions above or write your own below."));
    addInput.disabled = addBtn.disabled = items.length >= max;
    updateTotal();
  }

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    add(addInput.value);
    addInput.value = "";
  });

  save.addEventListener("click", async () => {
    const clean = items.map((i) => ({ ...i, name: i.name.trim() })).filter((i) => i.name);
    save.disabled = true;
    save.classList.add("loading");
    showError("");
    try {
      const saved = await api("/api/categories", { method: "PUT", body: { categories: clean, other_budget: otherBudget } });
      onSaved?.(saved);
    } catch (err) {
      showError(err.message);
    } finally {
      save.disabled = false;
      save.classList.remove("loading");
    }
  });

  const actions = onCancel
    ? el(
        "div",
        { class: "dialog-actions" },
        el("button", { type: "button", class: "ghost", onclick: onCancel }, "Cancel"),
        save,
      )
    : save;

  root.replaceChildren(
    el("h3", { class: "cat-h" }, "Suggestions"),
    chips,
    el("h3", { class: "cat-h" }, "Your categories ", count),
    list,
    addForm,
    el("div", { class: "cat-row other" }, el("div", { class: "cat-other-name" }, el("strong", {}, "Other"), el("span", { class: "muted small" }, "anything that fits nowhere else")), otherBudgetInput),
    total,
    error,
    actions,
  );
  if (onCancel) save.classList.remove("btn-block");
  render();
}

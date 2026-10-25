// City picker (D46): type a city, pick it from the matches, and the account
// uses that city's time zone for "today" and months. The list (about 7,300
// cities) is fetched from /data/cities.json the first time it's needed.
import { el } from "./lib.js";

let loading = null;
/** [{ name, ascii, province, country, tz, rank, key }] in population order. */
export function loadCities() {
  loading ??= fetch("/data/cities.json")
    .then((r) => {
      if (!r.ok) throw new Error("Couldn't load the city list.");
      return r.json();
    })
    .then((d) =>
      d.cities.map(([name, ascii, province, country, z], rank) => ({
        name,
        ascii,
        province,
        country,
        tz: d.zones[z],
        rank,
        key: fold(`${name} ${ascii}`),
        place: fold(`${province} ${country}`),
      })),
    )
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** Lower-case, accents removed: "São Paulo" -> "sao paulo". */
const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export const cityLabel = (c) => [c.name, c.country].filter(Boolean).join(", ");

/** Best matches for what was typed: city names first, then places in a matching region or country. */
export function searchCities(cities, query, limit = 8) {
  const q = fold(query.trim()).replace(/\s+/g, " ");
  if (!q) return [];
  const scored = [];
  for (const c of cities) {
    let score = -1;
    if (c.key.startsWith(q)) score = 0;
    else if (c.key.includes(` ${q}`)) score = 1;
    else if (q.length >= 3 && (c.place.startsWith(q) || c.place.includes(` ${q}`))) score = 2;
    if (score >= 0) scored.push([score, c.rank, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, limit).map((s) => s[2]);
}

/** "14:05 · GMT+2" for a time zone, right now. */
export function zoneTime(tz) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset" })
      .format(new Date())
      .replace(" ", " · ");
  } catch {
    return tz;
  }
}

/** The device's time zone and the biggest city in it, as a first pick for setup. */
export async function guessLocation() {
  let tz = "Africa/Cairo";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch {
    /* keep Cairo */
  }
  try {
    const best = (await loadCities()).find((c) => c.tz === tz);
    if (best) return { timezone: tz, city: cityLabel(best) };
  } catch {
    /* fall through */
  }
  return { timezone: tz, city: tz.split("/").pop().replace(/_/g, " ") };
}

let seq = 0;
/**
 * A search box with a list of matching cities. Calls onChange({ timezone, city })
 * when one is picked. `current` is { timezone, city } (either may be empty).
 */
export function cityPicker(current, onChange) {
  const id = `city-${++seq}`;
  let matches = [];
  let active = -1;
  let picked = current?.timezone ? { ...current } : null;

  const input = el("input", {
    id,
    type: "text",
    class: "city-input",
    placeholder: "Type your city, e.g. Cairo or London",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": `${id}-list`,
  });
  const list = el("ul", { id: `${id}-list`, class: "city-list", role: "listbox", "aria-label": "Matching cities", hidden: true });
  const status = el("p", { class: "city-status muted small", "aria-live": "polite" });

  function showPicked() {
    status.textContent = picked ? `${picked.city || picked.timezone}: ${zoneTime(picked.timezone)} now (${picked.timezone})` : "";
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function choose(c) {
    picked = { timezone: c.tz, city: cityLabel(c) };
    input.value = picked.city;
    close();
    showPicked();
    onChange(picked);
  }

  function highlight(i) {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute("aria-selected", String(n === i)));
    if (i >= 0) {
      input.setAttribute("aria-activedescendant", `${id}-opt-${i}`);
      list.children[i]?.scrollIntoView({ block: "nearest" });
    }
  }

  function render() {
    list.replaceChildren(
      ...matches.map((c, i) => {
        const li = el(
          "li",
          { id: `${id}-opt-${i}`, role: "option", class: "city-opt", "aria-selected": "false" },
          el("span", { class: "city-name" }, c.name, el("span", { class: "city-place" }, [c.province, c.country].filter(Boolean).join(", "))),
          el("span", { class: "city-time" }, zoneTime(c.tz)),
        );
        // mousedown keeps focus in the box, so the list doesn't close before the click lands.
        li.addEventListener("mousedown", (e) => e.preventDefault());
        li.addEventListener("click", () => choose(c));
        return li;
      }),
    );
    const open = matches.length > 0;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    highlight(open ? 0 : -1);
  }

  let pending = 0;
  input.addEventListener("input", async () => {
    const q = input.value;
    const mine = ++pending;
    if (!q.trim()) {
      matches = [];
      render();
      status.textContent = "";
      return;
    }
    try {
      const cities = await loadCities();
      if (mine !== pending) return; // a newer keystroke won
      matches = searchCities(cities, q);
      render();
      status.textContent = matches.length ? "" : "No city found. Try a bigger city nearby.";
    } catch (err) {
      status.textContent = err.message;
    }
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight((active + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight((active - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // close the list, not the dialog
      e.preventDefault();
      close();
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("focus", () => loadCities().catch(() => {}));

  if (picked) {
    input.value = picked.city ?? "";
    showPicked();
  }

  return el("div", { class: "city-picker" }, el("label", { class: "cur-label", for: id }, "Your city"), input, list, status);
}

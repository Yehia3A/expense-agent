// Currency picker (D45): the main currencies in a list, plus "Other currency…"
// for any ISO code (with suggestions from the browser's own list).
import { el } from "./lib.js";

export const MAIN = [
  "EGP", "USD", "EUR", "GBP", "SAR", "AED", "KWD", "QAR", "BHD", "OMR", "JOD", "MAD", "TND", "TRY",
  "INR", "PKR", "NGN", "KES", "ZAR", "CAD", "AUD", "CHF", "JPY", "CNY", "BRL", "MXN", "SGD", "MYR", "IDR", "PHP",
];

let names = null;
/** "USD" -> "US Dollar" (browser's own names; the code itself if unknown). */
export function currencyName(code) {
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "currency" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

function allCodes() {
  try {
    return Intl.supportedValuesOf("currency");
  } catch {
    return MAIN;
  }
}

const OTHER = "__other";

// Time zone -> currency, for a sensible first pick on the setup screen.
const ZONES = {
  "Africa/Cairo": "EGP", "Europe/London": "GBP", "Europe/Zurich": "CHF", "Europe/Istanbul": "TRY", "Europe/Stockholm": "SEK",
  "Europe/Oslo": "NOK", "Europe/Copenhagen": "DKK", "Europe/Warsaw": "PLN", "Europe/Prague": "CZK", "Europe/Budapest": "HUF",
  "Europe/Moscow": "RUB", "Asia/Riyadh": "SAR", "Asia/Dubai": "AED", "Asia/Kuwait": "KWD", "Asia/Qatar": "QAR", "Asia/Bahrain": "BHD",
  "Asia/Muscat": "OMR", "Asia/Amman": "JOD", "Asia/Beirut": "LBP", "Asia/Baghdad": "IQD", "Asia/Kolkata": "INR", "Asia/Calcutta": "INR",
  "Asia/Karachi": "PKR", "Asia/Dhaka": "BDT", "Asia/Tokyo": "JPY", "Asia/Shanghai": "CNY", "Asia/Hong_Kong": "HKD", "Asia/Singapore": "SGD",
  "Asia/Kuala_Lumpur": "MYR", "Asia/Jakarta": "IDR", "Asia/Manila": "PHP", "Asia/Seoul": "KRW", "Asia/Bangkok": "THB", "Asia/Jerusalem": "ILS",
  "Africa/Casablanca": "MAD", "Africa/Tunis": "TND", "Africa/Algiers": "DZD", "Africa/Lagos": "NGN", "Africa/Nairobi": "KES",
  "Africa/Johannesburg": "ZAR", "Africa/Accra": "GHS", "America/Toronto": "CAD", "America/Vancouver": "CAD", "America/Sao_Paulo": "BRL",
  "America/Mexico_City": "MXN", "America/Argentina/Buenos_Aires": "ARS", "America/Bogota": "COP", "America/Santiago": "CLP",
  "Pacific/Auckland": "NZD",
};

/** Best guess for a new account, from the device's time zone. */
export function guessCurrency(fallback = "EGP") {
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return fallback;
  }
  if (ZONES[tz]) return ZONES[tz];
  if (tz.startsWith("Australia/")) return "AUD";
  if (tz.startsWith("Europe/")) return "EUR";
  if (tz.startsWith("America/")) return "USD";
  return fallback;
}

/**
 * A labelled select with the main currencies and "Other currency…", which
 * shows a text box for any 3-letter code. Calls onChange(code) with a valid
 * upper-case code, or onChange(null) while the typed code isn't valid yet.
 */
export function currencyPicker(value, onChange, { id = `cur-${Math.random().toString(36).slice(2, 8)}` } = {}) {
  const codes = new Set(allCodes());
  const isMain = MAIN.includes(value);
  const select = el(
    "select",
    { id, class: "cur-select", "aria-label": "Currency" },
    ...MAIN.map((c) => el("option", { value: c }, `${c} · ${currencyName(c)}`)),
    // A non-main code chosen earlier stays visible as its own option.
    !isMain && value ? el("option", { value }, `${value} · ${currencyName(value)}`) : null,
    el("option", { value: OTHER }, "Other currency…"),
  );
  select.value = value || "EGP";

  const listId = `${id}-all`;
  const datalist = el("datalist", { id: listId }, ...[...codes].map((c) => el("option", { value: c }, currencyName(c))));
  const other = el("input", {
    type: "text",
    class: "cur-other",
    maxlength: "3",
    placeholder: "Code, e.g. XOF",
    list: listId,
    autocapitalize: "characters",
    spellcheck: "false",
    "aria-label": "Currency code",
    hidden: true,
  });
  const hint = el("span", { class: "cur-hint muted small", "aria-live": "polite" });

  const valid = (c) => /^[A-Z]{3}$/.test(c) && (codes.size < 50 || codes.has(c));
  select.addEventListener("change", () => {
    const pickOther = select.value === OTHER;
    other.hidden = !pickOther;
    hint.textContent = "";
    if (pickOther) {
      other.value = "";
      other.focus();
      onChange(null);
    } else onChange(select.value);
  });
  other.addEventListener("input", () => {
    const c = other.value.trim().toUpperCase();
    if (valid(c)) {
      hint.textContent = currencyName(c);
      onChange(c);
    } else {
      hint.textContent = c.length === 3 ? "Unknown code" : "";
      onChange(null);
    }
  });

  return el("div", { class: "cur-picker" }, el("label", { class: "cur-label", for: id }, "Currency"), el("div", { class: "cur-controls" }, select, other, hint), datalist);
}

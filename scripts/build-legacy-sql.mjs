// Builds .wrangler/legacy_import.sql from data/legacy_totals.json after
// checking each month reconciles with its Excel total. Used by
// `npm run db:import-legacy:local` / `:remote`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CATEGORIES = ["food_dining", "groceries", "transport_fuel", "bills_utilities", "entertainment", "shopping", "sports", "other"];
const data = JSON.parse(readFileSync("data/legacy_totals.json", "utf8"));

const rows = [];
for (const [month, cats] of Object.entries(data.months)) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`bad month '${month}'`);
  for (const [category, amount] of Object.entries(cats)) {
    if (!CATEGORIES.includes(category)) throw new Error(`${month}: unknown category '${category}'`);
    if (typeof amount !== "number" || amount < 0) throw new Error(`${month}/${category}: bad amount`);
    rows.push({ month, category, amount });
  }
}
for (const [month, expected] of Object.entries(data.expected_totals)) {
  const sum = rows.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0);
  if (Math.abs(sum - expected) > 0.005) throw new Error(`${month}: categories sum to ${sum}, Excel total is ${expected}`);
  console.log(`${month}: ${sum} reconciles with Excel total ${expected}`);
}

const sql = rows
  .map(
    (r) =>
      `INSERT INTO legacy_monthly_totals (month, category, amount) VALUES ('${r.month}', '${r.category}', ${r.amount}) ` +
      `ON CONFLICT (month, category) DO UPDATE SET amount = excluded.amount;`,
  )
  .join("\n");
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/legacy_import.sql", sql + "\n");
console.log(`wrote ${rows.length} rows to .wrangler/legacy_import.sql`);

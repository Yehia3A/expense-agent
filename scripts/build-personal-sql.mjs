// Builds .wrangler/personal_seed.sql from data/personal.json (gitignored):
//   - legacy monthly totals, after checking each month adds up to its expected total;
//   - starting budgets, only where no budget is set yet (edits made in the app win).
// Used by `npm run db:seed-personal:local` / `:remote` and scripts/setup-cloudflare.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CATEGORIES = ["food_dining", "groceries", "transport_fuel", "bills_utilities", "entertainment", "shopping", "sports", "other"];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const file = existsSync("data/personal.json") ? "data/personal.json" : null;
if (!file) {
  console.error("data/personal.json not found. Copy data/personal.example.json to data/personal.json and fill in your numbers.");
  process.exit(1);
}
const data = JSON.parse(readFileSync(file, "utf8"));
const sql = [];

// Legacy totals.
const legacy = data.legacy ?? { months: {}, expected_totals: {} };
const rows = [];
for (const [month, cats] of Object.entries(legacy.months ?? {})) {
  if (!MONTH.test(month)) throw new Error(`legacy: bad month '${month}'`);
  for (const [category, amount] of Object.entries(cats)) {
    if (!CATEGORIES.includes(category)) throw new Error(`legacy ${month}: unknown category '${category}'`);
    if (typeof amount !== "number" || amount < 0) throw new Error(`legacy ${month}/${category}: bad amount`);
    rows.push({ month, category, amount });
  }
}
for (const [month, expected] of Object.entries(legacy.expected_totals ?? {})) {
  const sum = rows.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0);
  if (Math.abs(sum - expected) > 0.005) throw new Error(`legacy ${month}: categories sum to ${sum}, expected total is ${expected}`);
  console.log(`legacy ${month}: ${sum} reconciles with ${expected}`);
}
for (const r of rows) {
  sql.push(
    `INSERT INTO legacy_monthly_totals (month, category, amount) VALUES ('${r.month}', '${r.category}', ${r.amount}) ` +
      `ON CONFLICT (month, category) DO UPDATE SET amount = excluded.amount;`,
  );
}

// Budgets: fill only where nothing is set yet.
const b = data.budgets;
if (b) {
  if (!MONTH.test(b.month)) throw new Error(`budgets: bad month '${b.month}'`);
  for (const [category, amount] of Object.entries(b.amounts ?? {})) {
    if (!CATEGORIES.includes(category)) throw new Error(`budgets: unknown category '${category}'`);
    if (amount !== null && (typeof amount !== "number" || amount < 0)) throw new Error(`budgets/${category}: bad amount`);
    if (amount === null) continue;
    sql.push(
      `INSERT INTO budgets (category, month, amount) VALUES ('${category}', '${b.month}', ${amount}) ` +
        `ON CONFLICT (category, month) DO UPDATE SET amount = excluded.amount WHERE budgets.amount IS NULL;`,
    );
  }
  console.log(`budgets ${b.month}: ${Object.values(b.amounts ?? {}).filter((v) => v !== null).length} categories (only where unset)`);
}

mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/personal_seed.sql", (sql.length ? sql.join("\n") : "SELECT 1;") + "\n");
console.log(`wrote ${sql.length} statements to .wrangler/personal_seed.sql`);

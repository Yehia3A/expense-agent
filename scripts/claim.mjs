// Attach data to your account (D34), after you have signed up in the app:
//   - rows from before multi-user (owner 'unclaimed') move to your account;
//   - your budgets and spreadsheet totals from data/personal.json (if present)
//     are seeded into your account (budgets only where you have none yet).
//
//   npm run claim:remote -- <username>      (the live app)
//   npm run claim:local -- <username>       (wrangler dev)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const where = args.includes("--local") ? "--local" : "--remote";
const username = args.find((a) => !a.startsWith("--"));
if (!username || !/^[A-Za-z0-9._@-]{3,40}$/.test(username)) {
  console.error("Usage: npm run claim:remote -- <your username>");
  process.exit(1);
}

function wrangler(cmdArgs, capture = false) {
  const r = spawnSync("npx", ["wrangler", ...cmdArgs], {
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, CI: "1" },
  });
  if (r.status !== 0) throw new Error(`wrangler ${cmdArgs.join(" ")} failed`);
  return r.stdout ?? "";
}

// On Windows the arguments go through cmd.exe (npx is a .cmd file), which splits on
// spaces, so the query needs its own quotes there. The username can't contain quotes.
const query = `SELECT id FROM users WHERE username = '${username}'`;
const out = wrangler(["d1", "execute", "expense_agent", where, "--json", "--command", process.platform === "win32" ? `"${query}"` : query], true);
const id = JSON.parse(out)?.[0]?.results?.[0]?.id;
if (!id) {
  console.error(`No account named "${username}". Create it in the app first (sign up), then run this again.`);
  process.exit(1);
}

const me = `'${id}'`;
const sql = [
  // OR IGNORE: anything you already have for the same key wins; leftovers are dropped below.
  `UPDATE OR IGNORE expenses SET user_id = ${me} WHERE user_id = 'unclaimed';`,
  `UPDATE OR IGNORE budgets SET user_id = ${me} WHERE user_id = 'unclaimed';`,
  `UPDATE OR IGNORE legacy_monthly_totals SET user_id = ${me} WHERE user_id = 'unclaimed';`,
  `UPDATE OR IGNORE merchant_map SET user_id = ${me} WHERE user_id = 'unclaimed';`,
  `UPDATE OR IGNORE user_categories SET user_id = ${me} WHERE user_id = 'unclaimed';`,
  `UPDATE logs SET user_id = ${me} WHERE user_id IS NULL;`,
  `DELETE FROM budgets WHERE user_id = 'unclaimed';`,
  `DELETE FROM legacy_monthly_totals WHERE user_id = 'unclaimed';`,
  `DELETE FROM merchant_map WHERE user_id = 'unclaimed';`,
  `DELETE FROM user_categories WHERE user_id = 'unclaimed';`,
];
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/claim.sql", sql.join("\n") + "\n");
console.log(`Attaching unclaimed data to ${username} (${where.slice(2)})...`);
wrangler(["d1", "execute", "expense_agent", where, "--file=.wrangler/claim.sql"]);

if (existsSync("data/personal.json")) {
  const b = spawnSync("node", ["scripts/build-personal-sql.mjs", "--user", username], { stdio: "inherit" });
  if (b.status !== 0) process.exit(1);
  if (readFileSync(".wrangler/personal_seed.sql", "utf8").trim() !== "SELECT 1;") {
    wrangler(["d1", "execute", "expense_agent", where, "--file=.wrangler/personal_seed.sql"]);
  }
}
console.log(`Done. Reload the app as ${username}.`);

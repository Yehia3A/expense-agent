// Reset a forgotten password (there is no email, so the owner does it):
// sets a random temporary password and signs the account out everywhere.
// The account's data stays. Tell the person to sign in with the temporary
// password and change it from the user menu.
//
//   npm run reset-password:remote -- <username>
//   npm run reset-password:local -- <username>
import { spawnSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const where = args.includes("--local") ? "--local" : "--remote";
const username = args.find((a) => !a.startsWith("--"));
if (!username || !/^[A-Za-z0-9._@-]{3,40}$/.test(username)) {
  console.error("Usage: npm run reset-password:remote -- <username>");
  process.exit(1);
}

// Same format and cost as src/security/passwords.ts.
const ITERATIONS = 20_000;
const temp = randomBytes(12).toString("base64url");
const salt = randomBytes(16);
const hash = pbkdf2Sync(temp.normalize("NFKC"), salt, ITERATIONS, 32, "sha256");
const stored = `pbkdf2-sha256$${ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;

const sql = [
  `UPDATE users SET password_hash = '${stored}', updated_at = '${new Date().toISOString()}' WHERE username = '${username}';`,
  `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = '${username}');`,
  `SELECT COUNT(*) AS found FROM users WHERE username = '${username}';`,
];
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/reset.sql", sql.join("\n") + "\n");

const r = spawnSync("npx", ["wrangler", "d1", "execute", "expense_agent", where, "--json", "--file=.wrangler/reset.sql"], {
  shell: process.platform === "win32",
  encoding: "utf8",
  env: { ...process.env, CI: "1" },
});
writeFileSync(".wrangler/reset.sql", ""); // the hash is not a secret, but don't leave it lying around
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
if (!/"found":\s*1/.test(r.stdout ?? "")) {
  console.error(`No account named "${username}".`);
  process.exit(1);
}
console.log(`Temporary password for ${username}:\n\n    ${temp}\n\nSign in with it, then change it from the user menu.`);

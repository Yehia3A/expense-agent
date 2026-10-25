// One-time Cloudflare setup and deploy, run from your own terminal after
// `npx wrangler login`:
//
//   npm run setup:cloudflare
//
// It is safe to re-run: every step checks what already exists.
//   1. Finds or creates the D1 database and writes its id into wrangler.jsonc.
//   2. Applies migrations to the remote database.
//   3. Seeds your budgets and old spreadsheet totals from data/personal.json (if present).
//   4. Deploys the Worker (static UI + API) to workers.dev.
//   5. Sets the LLM_API_KEY secret (asks you).
// Accounts are created in the app itself (open sign-up). Your old data and
// personal numbers are attached to your account afterwards with
// `npm run claim:remote -- <username>`.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const DB_NAME = "expense_agent";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

function run(args, { input, capture = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    shell: process.platform === "win32",
    input,
    encoding: "utf8",
    stdio: capture || input !== undefined ? ["pipe", "pipe", "inherit"] : "inherit",
  });
  if (r.status !== 0) {
    if (capture && r.stdout) process.stdout.write(r.stdout);
    throw new Error(`wrangler ${args.join(" ")} failed (exit ${r.status})`);
  }
  return r.stdout ?? "";
}

const step = (n, msg) => console.log(`\n[${n}/5] ${msg}`);

async function main() {
  // 0. Logged in?
  const who = spawnSync("npx", ["wrangler", "whoami"], { shell: process.platform === "win32", encoding: "utf8" });
  if (who.status !== 0 || /not authenticated/i.test(who.stdout + who.stderr)) {
    console.error("Not logged in. Run `npx wrangler login` first, then re-run this script.");
    process.exit(1);
  }

  // 1. Database.
  step(1, "D1 database");
  const config = readFileSync("wrangler.jsonc", "utf8");
  const configured = /"database_id":\s*"([0-9a-f-]{36})"/.exec(config)?.[1];
  const list = JSON.parse(run(["d1", "list", "--json"], { capture: true }));
  // A fork or clone carries the original owner's database id; it only counts
  // if that database is in the Cloudflare account you're logged in to.
  let id = configured && configured !== PLACEHOLDER && list.some((d) => d.uuid === configured) ? configured : null;
  if (!id) {
    if (configured && configured !== PLACEHOLDER) console.log(`Database ${configured} from wrangler.jsonc isn't in this Cloudflare account; using your own.`);
    const existing = list.find((d) => d.name === DB_NAME);
    if (existing) {
      id = existing.uuid;
      console.log(`Found existing database ${DB_NAME} (${id}).`);
    } else {
      const out = run(["d1", "create", DB_NAME], { capture: true });
      id = /"database_id":\s*"([0-9a-f-]{36})"/.exec(out)?.[1] ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out)?.[1];
      if (!id) throw new Error("Could not read the new database id from wrangler's output:\n" + out);
      console.log(`Created database ${DB_NAME} (${id}).`);
    }
    writeFileSync("wrangler.jsonc", config.replace(configured ?? PLACEHOLDER, id));
    console.log("Wrote database_id into wrangler.jsonc (commit this change).");
  } else {
    console.log(`Using database ${id} from wrangler.jsonc.`);
  }

  // 2. Migrations.
  step(2, "Migrations");
  run(["d1", "migrations", "apply", DB_NAME, "--remote"], { input: "y\n" });

  // 3. Personal numbers belong to an account, so they come after sign-up.
  step(3, "Your budgets and spreadsheet totals");
  console.log("After you create your account in the app, run: npm run claim:remote -- <your username>");

  // 4. Deploy (before secrets, so `secret put` targets an existing Worker).
  step(4, "Deploy");
  run(["deploy"]);

  // 5. Secrets.
  step(5, "Secrets");
  const existing = JSON.parse(run(["secret", "list", "--format", "json"], { capture: true }) || "[]").map((s) => s.name);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (!existing.includes("LLM_API_KEY")) {
    const key = (await rl.question("Paste your Groq API key (from console.groq.com/keys): ")).trim();
    if (key) run(["secret", "put", "LLM_API_KEY"], { input: key });
    else console.log("Skipped. Chat will say the key is missing until you run: npx wrangler secret put LLM_API_KEY");
  } else {
    console.log("LLM_API_KEY already set.");
  }
  rl.close();

  console.log("\nDone. Open the app, create your account, then run: npm run claim:remote -- <your username>");
}

main().catch((e) => {
  console.error(`\nSetup stopped: ${e.message}`);
  process.exit(1);
});

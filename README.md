# ExpenseAgent

A personal expense tracker you talk to. Type `coffee 200, vegs 400`; it records both items with today's date (Cairo time), files them under the right categories, and shows how much of each budget you've used. Built on Cloudflare Workers + D1 with free-tier LLM tool calling.

Project plan: Notion page "Intelligent expenses tracker". Decisions made along the way: [docs/DECISIONS.md](docs/DECISIONS.md).

## Status

| Phase | State |
|---|---|
| 0. Setup | Done locally. Cloudflare deploy needs your login (see below). |
| 1. Core domain | Done: schema, Cairo date utility, 8 tools, per-month budgets with copy-forward, legacy import. |
| 2. Chat + MVP UI | Done: `/chat` tool-calling loop, model config, chat UI with undo/confirm, budget table, recent expenses, request logs. |
| 3. Security | Done in code: Access JWT verification, fail-closed auth, rate limits, CSRF guard, CSP. Turning on Access needs your dashboard: [docs/SECURITY.md](docs/SECURITY.md). |
| 4. Reports + History | Done: monthly report (totals vs last month, category and daily charts, top expenses and items, projection, needs-review), 12-month history with month detail, all reconciled against the budget table. |

## How it works

```
Browser (public/: HTML + JS, Track / Report / History)
   |  HTTPS, behind Cloudflare Access; same origin
   v
Worker (src/index.ts): auth (Access JWT or APP_TOKEN), CSRF guard, rate limits
   |-- /chat  -> src/chat/loop.ts: LLM picks tools, code runs them
   |-- /api/* -> the same tool functions, called directly by the UI
   |-- Tool layer (src/tools/): add, list, update, delete, undo, summarize,
   |                               budget_status, set_budget, monthly_report, top_spending, monthly_history
   v
D1 (migrations/): expenses, budgets, categories, legacy_monthly_totals, merchant_map, logs, rate_limits
```

The model never writes a date, a total or a percentage. It chooses a tool and fills in amount, category, note and a relative `date_token` (`yesterday`, `weekday:fri`, and so on). Code turns the token into a calendar date in Africa/Cairo time. Every number in the UI comes from SQL, and every status line is built by code.

## Run it locally

```bash
npm install
```

```bash
npm run db:migrate:local
```

```bash
npm run db:import-legacy:local
```

Then pick a model:

- **Real model:** copy `.dev.vars.example` to `.dev.vars` and set `LLM_API_KEY` to a Groq key (free at console.groq.com). Leave `LLM_BASE_URL` unset.
- **No key yet:** keep the provided `.dev.vars` (it points at the mock) and run `node scripts/mock-llm.mjs` in a second terminal. The mock only understands simple `item amount, item amount` messages.

```bash
npm run dev
```

Open http://localhost:8787.

## Tests

```bash
npm test
```

About 130 tests across date handling (including midnight in Cairo in summer and winter time), every tool, budgets, reports and history (including a check that the budget table, report and history agree), the legacy import reconciliation, the `/chat` loop with a scripted fake LLM, the HTTP routes, and security: Access JWT verification with a fake issuer, fail-closed auth, CSRF and rate limits.

## Deploy (first time)

These steps need your Cloudflare login, so run them yourself:

```bash
npx wrangler login
```

```bash
npx wrangler d1 create expense_agent
```

Copy the printed `database_id` into `wrangler.jsonc`, then:

```bash
npm run db:migrate:remote
```

```bash
npm run db:import-legacy:remote
```

```bash
npx wrangler secret put LLM_API_KEY
```

```bash
npx wrangler secret put APP_TOKEN
```

```bash
npm run deploy
```

The deployed Worker refuses every API call until auth is configured. Set `APP_TOKEN` (the browser asks for it once and remembers it), then put Cloudflare Access in front following [docs/SECURITY.md](docs/SECURITY.md) and run its checklist before entering real data.

## Configuration

| Name | Where | Default |
|---|---|---|
| `LLM_PROVIDER` | `wrangler.jsonc` vars | `groq` (or `openrouter`) |
| `LLM_MODEL` | vars | `openai/gpt-oss-120b` |
| `LLM_BASE_URL` | vars or `.dev.vars` | derived from the provider |
| `LARGE_AMOUNT_THRESHOLD` | vars | `5000` EGP: larger amounts need a Confirm click |
| `OLD_DATE_CONFIRM_DAYS` | vars | `60` |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | vars | empty (Access JWT check off) |
| `CHAT_RATE_PER_MIN`, `CHAT_RATE_PER_DAY`, `API_RATE_PER_MIN` | vars | `20`, `500`, `300` (0 disables) |
| `LLM_API_KEY`, `APP_TOKEN` | secrets / `.dev.vars` | none |

## Budgets

The monthly total budget is 31,000 EGP. Other is 18,650: it holds what is left each month, invested in Thndr index funds, gold or bitcoin. Investment entries filed under Other are not flagged for review; anything else filed there is. The remaining 12,350 is spread across the other categories; set each one on the Track tab (click "set") or by chat ("set groceries to 3000").

## Legacy data

`data/legacy_totals.json` holds monthly totals from the Excel sheets. They are stored as totals, never as fake transactions. The import refuses any month whose categories don't add up to its Excel total. Only October 2026 (1,800 EGP) is imported; earlier months stay empty on purpose.

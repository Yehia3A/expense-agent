# Changelog

## 0.8.0 (2026-10-21): Your own budget, voice, driving mode

- Each account sets up its own categories (up to 10, suggestions or free text, any language) with monthly budgets, plus Other; edit them any time; renaming keeps history (migration 0008).
- History starts at sign-up (plus the month before), and earlier only where there are records.
- Voice input with Groq Whisper (free), auto-stop on silence; driving mode with one huge button, a cancellable auto-send countdown and the screen kept on.
- `list_categories` tool for MCP clients.
- Quick log: one-tap buttons for your 5 most common entries, with your last amount.
- Pick your currency (30 main ones or any ISO code) in setup, the account menu or Edit categories; budgets and totals use it (migration 0009).
- City and time zone per account: type your city and pick it (about 7,300 cities); "today", months and history follow it (migration 0010).

## 0.7.0 (2026-10-20): Open to everyone

- Public sign-up with just a username and password; every account's data is private to it (per-user rows and queries, migration 0007), with cross-account isolation tests.
- Personal API tokens for MCP clients replace the shared APP_TOKEN; Delete account; operator password reset script.
- Per-account chat limits, a shared daily cap on LLM use, sign-up limits and a `SIGNUP_OPEN` switch.
- Welcome card with Sign in / Create account tabs.
- `npm run claim:remote -- <username>` attaches pre-existing data and your personal numbers to your account.

## 0.6.0 (2026-10-20): Sign-in and look

- Username + password sign-in with 30-day sliding sessions (HttpOnly cookie, hashed session ids), first-account setup with the APP_TOKEN as setup key, change password, sign out, sign-in rate limits.
- New welcome screen with the sign-in card in the middle; browser password autofill.
- In-page dialogs and toasts instead of the browser's confirm()/prompt().
- Dark theme by default with a light/dark switch.

## 0.5.0 (2026-10-20): Phases 5–7

- Regex fast path for plain `item amount` messages, plus a merchant cache (term → category) learned from saves and corrections, never from rows flagged for review. Covered messages skip the LLM entirely.
- Fallback model when the main model's free quota returns 429.
- Token usage recorded per chat request.
- Eval harness: 82 labelled cases, a scorer (field accuracy, item recall, false writes, tool choice, clarifications, latency, tokens) and a driver comparing models and modes.
- Remote MCP server at `/mcp` (Streamable HTTP, stateless) over the same 11 tools; SDK client script; docs/MCP.md.
- One-command Cloudflare setup (`npm run setup:cloudflare`) and a GitHub Actions deploy workflow.
- Personal budgets and spreadsheet totals moved out of the repo into gitignored `data/personal.json`.

## 0.4.0 (2026-10-20): Phases 3–4

- Cloudflare Access JWT verification, fail-closed auth, D1-backed rate limits, CSRF guard, CSP and security headers.
- Monthly report, top spending and 12-month history tools; Report and History views with charts.
- Other holds monthly investments; those entries are not flagged for review.

## 0.2.0 (2026-10-19): Phases 0–2

- Worker + D1 project, schema, Cairo date utility, 8 tools, per-month budgets with copy-forward, legacy totals import.
- `/chat` tool-calling loop with idempotent replay, model config, request logging; chat UI with undo and confirm, budget table and recent expenses.

# Changelog

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

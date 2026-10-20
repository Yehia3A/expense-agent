# Decision log

One line per decision, with the reason. IDs D1-D7 come from the project plan in Notion; D8 onward were made during implementation.

| ID | Date | Decision | Reason |
|----|------|----------|--------|
| D1 | 2026-10-19 | Keep `other` for v1; every expense the model files as `other` gets `needs_review = 1`. | Plan default. Revisit once you decide what the 12,650 EGP "Other" budget really covers (rent, savings, debt, car). |
| D2 | 2026-10-19 | Import monthly totals only, into `legacy_monthly_totals`, never as fake transactions. | Plan default. The July 2026 detail sheet is empty, and fake rows would pollute top-items reports. |
| D3 | 2026-10-19 | Large-amount confirmation threshold = 5,000 EGP (`LARGE_AMOUNT_THRESHOLD` var). | Plan default. |
| D4 | 2026-10-19 | Budget changes copy forward: `set_budget` updates the chosen month and every later month that already has rows, unless `apply_forward=false`. | Plan default. Past months are never touched. |
| D8 | 2026-10-19 | Serve the UI from the Worker itself (Workers Static Assets) instead of a separate Pages project. | One deployment, same origin (no CORS), one Access policy to set up in Phase 3. Cloudflare now recommends this over Pages for new projects. |
| D9 | 2026-10-19 | Spending for a month = real expenses + legacy totals for that month. | October 2026 is partly in Excel (1,800 EGP) and will continue in the app. Adding the two keeps October correct as long as nothing is entered twice. |
| D10 | 2026-10-19 | TOTAL % Used = spending in budgeted categories / sum of budgets. Unbudgeted spending is its own line in the total. | Keeps numerator and denominator over the same categories while never hiding unbudgeted spending. |
| D11 | 2026-10-19 | Large amounts and dates more than 60 days back are not written by the model. The tool returns `needs_confirmation`, and the UI shows a Confirm button that calls `POST /api/expenses` with `confirmed: true`. | Confirmation does not depend on the model reading "yes" correctly. |
| D12 | 2026-10-19 | `/chat` idempotency: the full response is stored in `logs.response` under `request_id`. A retry with the same `request_id` returns the stored response without calling the LLM again. `UNIQUE(request_id, line_index)` stays as a database-level backstop. | A re-run of the LLM could return different items, so line-level dedupe alone is not enough. |
| D13 | 2026-10-19 | Provisional default model: `openai/gpt-oss-120b` on Groq (OpenAI-compatible API). OpenRouter works through the same client. | Free tier, supports tool calling. Phase 5 evals pick the real default. |
| D14 | 2026-10-19 | Until Phase 3, an optional `APP_TOKEN` secret protects `/api` and `/chat` (Bearer header). | Plan's fallback auth. Cloudflare Access is added in Phase 3, before real data goes into the deployed app. |
| D15 | 2026-10-19 | `add_expense` takes an `items` array, so a multi-item message is one call and one atomic batch. | Fewer round trips, one `request_id`, and `line_index` comes from array order. |
| D16 | 2026-10-19 | Tool inputs are validated with zod; the JSON Schemas sent to the LLM are generated from the same zod schemas. | One definition of each tool for `/chat`, `/api` and (Phase 6) `/mcp`. |
| D17 | 2026-10-19 | The model passes a `date_token` (`today`, `yesterday`, `days_ago:N`, `weekday:fri`, `day:5`, `date:YYYY-MM-DD`); code resolves it in Africa/Cairo time. | Plan F2: the model never produces the stored date. |
| D18 | 2026-10-19 | Non-EGP expenses are stored as entered but left out of budget totals and summaries; the budget view lists them separately. | Plan scope: no currency conversion. Adding USD to EGP totals would be wrong. |
| D19 | 2026-10-19 | Tests use `@cloudflare/vitest-plugin` 1.3.6 (the renamed `vitest-pool-workers`), with `compatibility_date` 2026-09-15 so the bundled test runtime supports it. | Plan: Vitest + Miniflare, pinned versions at least two weeks old. |
| D20 | 2026-10-19 | The UI is plain JavaScript (no build step), not TypeScript. | Three small files; a bundler would add setup without adding safety for this size. Worker code stays TypeScript. |
| D21 | 2026-10-19 | `scripts/mock-llm.mjs` is a keyword-based fake of the OpenAI API for local UI work without a key. It is not a parser and is never deployed. | Lets the full stack run locally; real behavior is measured with real models in Phase 5. |

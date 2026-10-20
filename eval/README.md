# Evals (Phase 5)

`cases.json` holds 82 labelled messages: plain and multi-item spending, relative dates, typos, Franglish and Arabic, large amounts that need confirmation, messages that should get a clarifying question, chit-chat that must never write, spending questions and budget commands. The clock is fixed at Monday 2026-10-19 12:00 Cairo, so expected dates are absolute. `seed_inputs.jsonl` is the original Phase 0 seed list.

**Add your own messages.** The best eval set is how you actually type. Copy a line in `cases.json`, give it a new `id`, and set `expect`.

## Run

```bash
node scripts/eval.mjs --mode fastpath
```
No model and no key: shows how much the regex + merchant-cache fast path handles alone, and whether it ever writes something wrong.

```bash
node scripts/eval.mjs --mode llm,hybrid --models groq:openai/gpt-oss-120b,groq:llama-3.3-70b-versatile,groq:qwen/qwen3-32b
```
The model comparison. `llm` sends every message to the model (the baseline); `hybrid` is what production does (fast path first). Needs `GROQ_API_KEY` (or `LLM_API_KEY` in `.dev.vars`). Model names change; check console.groq.com/docs/models.

Useful flags: `--cases a01,a05,r02` (a subset), `--limit 20`, `--delay 3000` (ms between cases; free tiers allow about 30 requests per minute), `--mock` (the keyword mock in `scripts/mock-llm.mjs`, only to check the harness itself).

**Free-tier budget:** one LLM message costs roughly 2 calls and several thousand tokens (the system prompt plus 11 tool schemas). Groq's free tier for gpt-oss-120b is about 200k tokens per day, so a full 82-case `llm` run may not fit in one day for the larger models. Split it with `--cases` / `--limit`, or run the large model on one day and the others on the next.

## Output

- `eval/results/*.json`: every observation of every run (gitignored).
- `eval/RESULTS.md`: a table with the latest run per model and mode, plus each failure and why.

Metrics: per-field accuracy (amount, category, date), item recall on multi-item messages, false-write rate (rows that should not exist, or any write for non-spending messages), tool choice, clarification rate, share of messages needing the LLM, p50/p95 latency, tokens per 100 messages. Targets from the plan: at least 95% field accuracy, at most 1% false writes.

Scoring lives in `score.mjs` (unit-tested in `test/score.test.ts`); the cases run through the real `/chat` code in `run.eval.ts`.

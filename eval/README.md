# Eval set

`seed_inputs.jsonl` starts the Phase 5 eval set. One JSON object per line:

- `input`: the message exactly as you would type it (typos, Franglish and Arabic included).
- `expected`: either a list of items (`amount`, `category`, `date_token`, `note`) or one of `"clarify"`, `"query"`, `"set_budget"`, `"no_write"`.

The first lines are examples taken from the project plan. **Phase 0 task for you:** add real inputs until there are at least 20, written the way you actually type them. Phase 5 grows this to 60-100 and adds the scoring script.

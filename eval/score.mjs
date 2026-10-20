// Scoring for the Phase 5 eval (plan 13). Pure functions: one observation per
// case in, metrics out. Used by scripts/eval.mjs and unit-tested in
// test/score.test.ts.

const MUTATING = new Set(["add_expense", "update_expense", "delete_expense", "undo_request", "set_budget"]);
const asked = (reply) => /[?؟]/.test(reply ?? "");
const accepts = (expected, actual) => (Array.isArray(expected) ? expected.includes(actual) : expected === actual);
const near = (a, b) => Math.abs(a - b) < 0.005;

/** Pair expected items with saved rows: same amount first, then same category, then anything left. */
function match(expected, saved) {
  const left = saved.map((s, i) => i);
  const take = (pred) => {
    const k = left.findIndex((i) => pred(saved[i]));
    return k < 0 ? null : saved[left.splice(k, 1)[0]];
  };
  return expected.map((e) => take((s) => near(s.amount, e.amount)) ?? take((s) => accepts(e.category, s.category)) ?? take(() => true));
}

export function scoreCase(c, o) {
  const kind = c.expect.kind;
  const saved = o.saved ?? [];
  const pending = o.pending ?? [];
  const tools = o.tools ?? [];
  const mutated = tools.some((t) => MUTATING.has(t.name) && t.ok && t.name !== "add_expense") || saved.length > 0;
  const s = {
    id: c.id,
    kind,
    path: o.path,
    correct: false,
    right_action: false,
    false_write: false,
    unnecessary_clarification: false,
    fields: { amount: [0, 0], category: [0, 0], date: [0, 0] },
    items: [0, 0],
    why: "",
  };

  if (kind === "add") {
    const exp = c.expect.items;
    const pairs = match(exp, saved);
    let allFields = true;
    exp.forEach((e, i) => {
      const got = pairs[i];
      const okA = !!got && near(got.amount, e.amount);
      const okC = !!got && accepts(e.category, got.category);
      const okD = !!got && got.expense_date === e.date;
      s.fields.amount[0] += okA ? 1 : 0;
      s.fields.category[0] += okC ? 1 : 0;
      s.fields.date[0] += okD ? 1 : 0;
      s.items[0] += okA ? 1 : 0;
      if (!(okA && okC && okD)) {
        allFields = false;
        s.why ||= got
          ? `item ${i + 1}: got ${got.amount} ${got.category} ${got.expense_date}, want ${e.amount} ${[].concat(e.category).join("|")} ${e.date}`
          : `item ${i + 1} (${e.amount}) not saved`;
      }
    });
    for (const f of ["amount", "category", "date"]) s.fields[f][1] = exp.length;
    s.items[1] = exp.length;
    s.false_write = saved.length > exp.length;
    if (s.false_write) s.why ||= `saved ${saved.length} rows, expected ${exp.length}`;
    s.right_action = saved.length > 0;
    s.unnecessary_clarification = saved.length === 0 && pending.length === 0 && asked(o.reply);
    if (!saved.length) s.why ||= s.unnecessary_clarification ? `asked instead of saving: "${o.reply}"` : `nothing saved: "${o.reply ?? o.error}"`;
    s.correct = allFields && !s.false_write;
  } else if (kind === "confirm") {
    const amounts = pending.map((p) => p.amount);
    s.false_write = saved.length > 0;
    s.right_action = !saved.length && c.expect.amounts.every((a) => amounts.some((x) => near(x, a)));
    s.correct = s.right_action;
    if (!s.correct) s.why = saved.length ? "saved without confirmation" : `no pending confirmation: "${o.reply ?? o.error}"`;
  } else {
    s.false_write = mutated && kind !== "set_budget" ? true : saved.length > 0;
    if (kind === "clarify") {
      s.right_action = !mutated && !pending.length && asked(o.reply);
    } else if (kind === "no_write") {
      s.right_action = !mutated && !pending.length;
    } else if (kind === "query") {
      s.right_action = !mutated && tools.some((t) => c.expect.tools.includes(t.name));
    } else if (kind === "set_budget") {
      s.right_action =
        !saved.length &&
        tools.some((t) => t.name === "set_budget" && t.ok && t.args?.category === c.expect.category && near(Number(t.args?.amount), c.expect.amount));
    }
    s.correct = s.right_action;
    if (!s.correct) s.why = s.false_write ? "wrote data" : `tools: [${tools.map((t) => t.name).join(", ")}] reply: "${(o.reply ?? o.error ?? "").slice(0, 80)}"`;
  }
  return s;
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function summarize(cases, observations) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const scores = observations.filter((o) => byId.has(o.id)).map((o) => scoreCase(byId.get(o.id), o));
  const sum = (f) => scores.reduce((a, s) => a + f(s), 0);
  const adds = scores.filter((s) => s.kind === "add");
  const clar = scores.filter((s) => s.kind === "clarify");
  const lat = observations.map((o) => o.latency_ms).filter((x) => typeof x === "number");
  const llm = observations.filter((o) => o.path === "llm" || o.path === "deferred");
  const tokens = observations.reduce((a, o) => a + (o.usage ? o.usage.prompt_tokens + o.usage.completion_tokens : 0), 0);
  const byKind = {};
  for (const s of scores) {
    byKind[s.kind] ??= [0, 0];
    byKind[s.kind][0] += s.correct ? 1 : 0;
    byKind[s.kind][1] += 1;
  }
  return {
    cases: scores.length,
    accuracy_pct: pct(sum((s) => s.correct), scores.length),
    field_accuracy_pct: {
      amount: pct(sum((s) => s.fields.amount[0]), sum((s) => s.fields.amount[1])),
      category: pct(sum((s) => s.fields.category[0]), sum((s) => s.fields.category[1])),
      date: pct(sum((s) => s.fields.date[0]), sum((s) => s.fields.date[1])),
    },
    item_recall_pct: pct(sum((s) => s.items[0]), sum((s) => s.items[1])),
    false_write_rate_pct: pct(sum((s) => s.false_write), scores.length),
    tool_selection_pct: pct(sum((s) => s.right_action), scores.length),
    clarification_pct: pct(clar.filter((s) => s.correct).length, clar.length),
    unnecessary_clarification_pct: pct(adds.filter((s) => s.unnecessary_clarification).length, adds.length),
    llm_share_pct: pct(llm.length, observations.length),
    latency_ms: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) },
    tokens_per_100_messages: observations.length ? Math.round((100 * tokens) / observations.length) : 0,
    errors: observations.filter((o) => o.error).length,
    by_kind: Object.fromEntries(Object.entries(byKind).map(([k, [ok, n]]) => [k, `${ok}/${n}`])),
    failures: scores.filter((s) => !s.correct).map((s) => ({ id: s.id, path: s.path, why: s.why })),
  };
}

export function markdownReport(runs) {
  const head =
    "| Model | Mode | Cases | Correct | Amount | Category | Date | Item recall | False writes | Tool choice | Clarify | Needs LLM | p50 ms | p95 ms | Tokens/100 msgs | Errors |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  const f = (x) => (x === null || x === undefined ? "-" : `${x}%`);
  const rows = runs
    .map(({ model, mode, metrics: m }) =>
      `| ${model} | ${mode} | ${m.cases} | ${f(m.accuracy_pct)} | ${f(m.field_accuracy_pct.amount)} | ${f(m.field_accuracy_pct.category)} | ${f(m.field_accuracy_pct.date)} | ${f(m.item_recall_pct)} | ${f(m.false_write_rate_pct)} | ${f(m.tool_selection_pct)} | ${f(m.clarification_pct)} | ${f(m.llm_share_pct)} | ${m.latency_ms.p50 ?? "-"} | ${m.latency_ms.p95 ?? "-"} | ${m.tokens_per_100_messages} | ${m.errors} |`,
    )
    .join("\n");
  return head + rows + "\n";
}

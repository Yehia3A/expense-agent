// Tiny OpenAI-compatible mock for trying the UI without an API key.
// It only understands "item amount, item amount" messages and "undo".
//
//   node scripts/mock-llm.mjs            (listens on http://127.0.0.1:8788)
//   .dev.vars:  LLM_BASE_URL=http://127.0.0.1:8788/v1   LLM_API_KEY=mock
//
// Not a model: categories come from a small keyword table. Use a real key for anything else.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8788);
const KEYWORDS = [
  [/coffee|lunch|dinner|breakfast|restaurant|pizza|tea|snack/i, "food_dining"],
  [/veg|fruit|supermarket|meat|bread|milk|grocer/i, "groceries"],
  [/uber|careem|taxi|fuel|benzine|parking|metro|toll/i, "transport_fuel"],
  [/electric|water bill|internet|phone|gas bill/i, "bills_utilities"],
  [/cinema|movie|netflix|game/i, "entertainment"],
  [/shirt|shoes|clothes|tv|laptop/i, "shopping"],
  [/squash|gym|padel|court/i, "sports"],
];
const category = (note) => KEYWORDS.find(([re]) => re.test(note))?.[1] ?? "other";

function reply(message) {
  return { choices: [{ message: { role: "assistant", ...message } }] };
}

createServer(async (req, res) => {
  // Fake Whisper: any clip "says" the same thing.
  if (req.url?.endsWith("/audio/transcriptions")) {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ text: process.env.MOCK_TRANSCRIPT || "coffee 30" }));
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const { messages = [] } = JSON.parse(body || "{}");
  const last = messages.at(-1);
  let out;

  if (last?.role === "tool") {
    const result = JSON.parse(last.content);
    out = reply({ content: result.ok ? (result.result.status === "needs_confirmation" ? "Please press Confirm to save that." : "Done.") : `Error: ${result.error}` });
  } else {
    const text = String(last?.content ?? "").trim();
    if (/^undo/i.test(text)) {
      out = reply({ tool_calls: [{ id: "c1", type: "function", function: { name: "undo_request", arguments: "{}" } }] });
    } else {
      const yesterday = /\byesterday\b/i.test(text);
      const items = text
        .replace(/\byesterday\b/gi, "")
        .split(/,|\band\b|\n/i)
        .map((part) => /^\s*(.*?)\s*(\d+(?:\.\d+)?)\s*$/.exec(part))
        .filter(Boolean)
        .map(([, note, amount]) => ({
          amount: Number(amount),
          category: category(note),
          note: note.trim() || "item",
          ...(yesterday ? { date_token: "yesterday" } : {}),
        }));
      // Use only categories this account has (the system prompt lists them as "- key: Name").
      const keys = new Set([...String(messages[0]?.content ?? "").matchAll(/^- ([a-z0-9_]+): /gm)].map((m) => m[1]));
      for (const it of items) if (keys.size && !keys.has(it.category)) it.category = "other";
      out = items.length
        ? reply({ tool_calls: [{ id: "c1", type: "function", function: { name: "add_expense", arguments: JSON.stringify({ items }) } }] })
        : reply({ content: "(mock LLM) Tell me what you spent, like 'coffee 200, vegs 400'." });
    }
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}).listen(PORT, "127.0.0.1", () => console.log(`mock LLM on http://127.0.0.1:${PORT}/v1`));

// MCP client #2 (Phase 6): talks to the /mcp endpoint with the official SDK.
//
//   node scripts/mcp-client.mjs                       (local: http://localhost:8787/mcp)
//   node scripts/mcp-client.mjs https://<your-app>/mcp    (EXPENSE_AGENT_TOKEN env var: your personal API token)
//   node scripts/mcp-client.mjs <url> add "coffee" 45 food_dining
//
// Lists the tools, shows this month's budget status, and with `add` records
// one expense through MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url = "http://localhost:8787/mcp", cmd, note, amount, category] = process.argv.slice(2);
// Create the token in the app: user menu -> API token.
const token = process.env.EXPENSE_AGENT_TOKEN;
const headers = token ? { authorization: `Bearer ${token}` } : {};

const client = new Client({ name: "expense-agent-script", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));

const server = client.getServerVersion();
console.log(`Connected to ${server?.title ?? server?.name} ${server?.version}`);

const { tools } = await client.listTools();
console.log(`\n${tools.length} tools:`);
for (const t of tools) console.log(`  ${t.annotations?.readOnlyHint ? "read " : "write"}  ${t.name}`);

if (cmd === "add") {
  const r = await client.callTool({
    name: "add_expense",
    arguments: { items: [{ note: note ?? "coffee", amount: Number(amount ?? 45), category: category ?? "food_dining" }] },
  });
  console.log(`\nadd_expense -> ${r.isError ? "ERROR" : "ok"}`);
  console.log(r.content[0].text.split("\n\n")[0]);
}

const status = await client.callTool({ name: "budget_status", arguments: {} });
const s = status.structuredContent;
console.log(`\nBudget ${s.month}: spent ${s.total.spent} of ${s.total.budget} budgeted (${s.total.pct_used ?? "-"}%)`);
for (const row of s.rows.filter((r) => r.spent > 0)) console.log(`  ${row.display_name.padEnd(24)} ${String(row.spent).padStart(8)}`);

await client.close();

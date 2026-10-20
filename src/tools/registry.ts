import { z } from "zod";
import { budgetStatusTool, setBudgetTool } from "./budgets";
import { addExpenseTool, deleteExpenseTool, listExpensesTool, undoRequestTool, updateExpenseTool } from "./expenses";
import { summarizeTool } from "./reports";
import { ToolError, type Tool, type ToolContext } from "./types";

// The one tool layer (plan 6). /chat uses it through the LLM, /api calls the
// underlying functions directly, and /mcp (Phase 6) will expose the same list.
export const TOOLS: Tool[] = [
  addExpenseTool,
  listExpensesTool,
  updateExpenseTool,
  deleteExpenseTool,
  undoRequestTool,
  summarizeTool,
  budgetStatusTool,
  setBudgetTool,
] as Tool[];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string; details?: unknown };

/** Validate raw arguments and run a tool. Never throws for bad input; returns an error the model can read. */
export async function callTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const tool = byName.get(name);
  if (!tool) return { ok: false, error: `unknown tool '${name}'` };
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, error: "invalid arguments", details: z.treeifyError(parsed.error) };
  }
  try {
    return { ok: true, result: await tool.run(ctx, parsed.data) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.message, details: e.details };
    throw e;
  }
}

/** JSON Schema for each tool, generated from the zod input (D16). */
export function toolJsonSchemas() {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

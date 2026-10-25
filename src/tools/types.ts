import { z } from "zod";
import type { AppConfig } from "../env";
import { localDate } from "../lib/dates";

/** A category key from the account's own list (D41); see tools/categories.ts. */
export type CategoryKey = string;

/** A category as the model or a client gives it: a key or a name, checked against the account's list at run time. */
export const CategoryInput = z.string().trim().min(1).max(40);

export type Source = "chat" | "mcp" | "api" | "import";

/** Everything a tool needs. /chat, /api and (later) /mcp each build one per request. */
export interface ToolContext {
  db: D1Database;
  /** The signed-in account. Every query reads and writes only this user's rows (D34). */
  userId: string;
  now: () => Date;
  config: AppConfig;
  requestId: string;
  source: Source;
  /** Next line_index for add_expense within this request; shared across calls. */
  lineCounter: { next: number };
}

export function today(ctx: ToolContext): string {
  return localDate(ctx.now(), ctx.config.tz);
}

/** A failure the caller (model or UI) can act on. Not a bug. */
export class ToolError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  run(ctx: ToolContext, input: z.infer<S>): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

export interface ExpenseRow {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  category: CategoryKey;
  expense_date: string;
  note: string;
  needs_review: number;
  source: Source;
  request_id: string;
  line_index: number;
  created_at: string;
  deleted_at: string | null;
}

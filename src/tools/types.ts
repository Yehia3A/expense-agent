import { z } from "zod";
import type { AppConfig } from "../env";
import { localDate } from "../lib/dates";

export const CATEGORY_KEYS = [
  "food_dining",
  "groceries",
  "transport_fuel",
  "bills_utilities",
  "entertainment",
  "shopping",
  "sports",
  "other",
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];
export const CategoryEnum = z.enum(CATEGORY_KEYS);

export type Source = "chat" | "mcp" | "api" | "import";

/** Everything a tool needs. /chat, /api and (later) /mcp each build one per request. */
export interface ToolContext {
  db: D1Database;
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

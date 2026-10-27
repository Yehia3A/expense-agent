import { describe, expect, it } from "vitest";
import { toolJsonSchemas } from "../src/tools/registry";

describe("tool JSON schemas sent to the LLM (D16)", () => {
  const schemas = toolJsonSchemas();

  it("covers the full tool list", () => {
    expect(schemas.map((s) => s.name)).toEqual([
      "add_expense",
      "list_expenses",
      "update_expense",
      "delete_expense",
      "undo_request",
      "summarize",
      "budget_status",
      "set_budget",
      "monthly_report",
      "top_spending",
      "monthly_history",
      "list_categories",
    ]);
  });

  it("are plain object schemas without $schema", () => {
    for (const s of schemas) {
      expect(s.parameters.type).toBe("object");
      expect(s.parameters).not.toHaveProperty("$schema");
      expect(s.description.length).toBeGreaterThan(20);
    }
  });

  it("add_expense takes a category key (each account has its own list) and no date field, only date_token", () => {
    const add = schemas.find((s) => s.name === "add_expense")!.parameters as {
      properties: { items: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } };
    };
    const item = add.properties.items.items;
    expect(item.properties.category!.enum).toBeUndefined();
    expect(Object.keys(item.properties).sort()).toEqual(["amount", "category", "currency", "date_token", "details", "note"]);
    expect(item.required.sort()).toEqual(["amount", "category", "note"]);
  });
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fastPath } from "../src/chat/fastpath";
import { systemPrompt } from "../src/chat/prompt";
import { monthlyReport } from "../src/tools/history";
import { addExpenses, updateExpense } from "../src/tools/expenses";
import { makeCtx, resetDb, TEST_USER } from "./helpers";

// D47: optional notes on unusual one-offs, filed under Other, shown in the report.
beforeEach(resetDb);

const repair = { amount: 2000, category: "transport_fuel", note: "car wheel bearing", details: "Fixing the car's wheel bearing" };

describe("expense notes", () => {
  it("an item with notes is saved under Other, without a review flag, and says the note was saved", async () => {
    const r = await addExpenses(makeCtx({ requestId: "notes-1" }), [repair]);
    expect(r.status).toBe("saved");
    if (r.status !== "saved") return;
    expect(r.saved[0]).toMatchObject({ category: "other", details: "Fixing the car's wheel bearing", needs_review: 0 });
    expect(r.status_lines[0]).toContain("Note saved (shown in the Report).");
  });

  it("everyday items keep their category and have no notes", async () => {
    const r = await addExpenses(makeCtx({ requestId: "notes-2" }), [{ amount: 45, category: "food_dining", note: "coffee" }]);
    expect(r.status === "saved" && r.saved[0]).toMatchObject({ category: "food_dining", details: null });
  });

  it("blank notes count as no notes", async () => {
    const r = await addExpenses(makeCtx({ requestId: "notes-3" }), [{ ...repair, details: "   " }]);
    expect(r.status === "saved" && r.saved[0]).toMatchObject({ category: "transport_fuel", details: null });
  });

  it("notes can be added, changed and removed by editing", async () => {
    const r = await addExpenses(makeCtx({ requestId: "notes-4" }), [{ amount: 300, category: "other", note: "gift" }]);
    const id = r.status === "saved" ? r.saved[0]!.id : "";
    expect(r.status === "saved" && r.saved[0]!.needs_review).toBe(1);
    const added = await updateExpense(makeCtx(), id, { details: "Wedding gift for Omar" });
    expect(added.updated).toMatchObject({ details: "Wedding gift for Omar", needs_review: 0 });
    const removed = await updateExpense(makeCtx(), id, { details: null });
    expect(removed.updated).toMatchObject({ details: null, needs_review: 1 });
  });

  it("the monthly report lists expenses with notes, in any currency, but not deleted ones", async () => {
    await addExpenses(makeCtx({ requestId: "notes-5" }), [repair]);
    await addExpenses(makeCtx({ requestId: "notes-6" }), [{ amount: 40, currency: "USD", category: "other", note: "visa fee", details: "Embassy visa fee" }]);
    const gone = await addExpenses(makeCtx({ requestId: "notes-7" }), [{ amount: 90, category: "other", note: "fine", details: "Parking fine" }]);
    if (gone.status === "saved") await env.DB.prepare("UPDATE expenses SET deleted_at = 'x' WHERE id = ?").bind(gone.saved[0]!.id).run();
    const rep = await monthlyReport(makeCtx(), "2026-10");
    expect(rep.notes.map((n) => [n.note, n.amount, n.currency, n.details])).toEqual([
      ["car wheel bearing", 2000, "EGP", "Fixing the car's wheel bearing"],
      ["visa fee", 40, "USD", "Embassy visa fee"],
    ]);
  });

  it("one-offs with notes don't teach the merchant cache", async () => {
    await addExpenses(makeCtx({ requestId: "notes-8" }), [repair]);
    const learned = await env.DB.prepare("SELECT 1 FROM merchant_map WHERE user_id = ? AND term = 'car wheel bearing'").bind(TEST_USER).first();
    expect(learned).toBeNull();
  });

  it("the fast path doesn't file a long description by one known word", async () => {
    await env.DB.prepare("INSERT INTO merchant_map (user_id, term, category, hits, updated_at) VALUES ('', 'car', 'transport_fuel', 1, 'x')").run();
    expect(await fastPath(env.DB, TEST_USER, "2000 for fixing car wheel bearing")).toBeNull();
    // Short items still use word matches.
    expect(await fastPath(env.DB, TEST_USER, "car wash 50")).toMatchObject([{ note: "car wash", category: "transport_fuel" }]);
  });

  it("the chat prompt explains when to add notes", () => {
    const p = systemPrompt("2026-10-19", [], 5000);
    expect(p).toContain('"2000 for fixing car wheel bearing"');
    expect(p).toContain("Never add details to everyday");
  });
});

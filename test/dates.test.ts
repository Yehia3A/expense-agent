import { describe, expect, it } from "vitest";
import {
  addMonths,
  checkExpenseDate,
  localDate,
  monthRange,
  resolveDateToken,
} from "../src/lib/dates";
import { cairo } from "./helpers";

describe("localDate around midnight in Cairo (plan 7.1, O3)", () => {
  it("summer time (UTC+3): 23:59 stays on the same day, 00:01 is the next day", () => {
    expect(localDate(cairo("2026-10-19T23:59", 3))).toBe("2026-10-19");
    expect(localDate(cairo("2026-10-20T00:01", 3))).toBe("2026-10-20");
  });

  it("winter time (UTC+2): 23:59 stays on the same day, 00:01 is the next day", () => {
    expect(localDate(cairo("2026-12-01T23:59", 2))).toBe("2026-12-01");
    expect(localDate(cairo("2026-12-02T00:01", 2))).toBe("2026-12-02");
  });

  it("differs from the UTC date late in the evening", () => {
    const instant = new Date("2026-10-19T22:30:00Z"); // 01:30 on the 20th in Cairo
    expect(instant.toISOString().slice(0, 10)).toBe("2026-10-19");
    expect(localDate(instant)).toBe("2026-10-20");
  });

  it("month boundary at midnight", () => {
    expect(localDate(cairo("2026-11-30T23:59", 2))).toBe("2026-11-30");
    expect(localDate(cairo("2026-12-01T00:01", 2))).toBe("2026-12-01");
  });
});

describe("resolveDateToken", () => {
  const today = "2026-10-19"; // Monday

  it.each([
    [undefined, "2026-10-19"],
    ["", "2026-10-19"],
    ["today", "2026-10-19"],
    ["yesterday", "2026-10-18"],
    ["day_before_yesterday", "2026-10-17"],
    ["days_ago:3", "2026-10-16"],
    ["days_ago:0", "2026-10-19"],
    ["weekday:fri", "2026-10-16"],
    ["weekday:friday", "2026-10-16"],
    ["weekday:sun", "2026-10-18"],
    ["weekday:mon", "2026-10-12"], // "last Monday" on a Monday is a week ago
    ["weekday:tue", "2026-10-13"],
    ["day:5", "2026-10-05"],
    ["day:19", "2026-10-19"],
    ["day:25", "2026-09-25"], // the 25th hasn't happened this month yet
    ["date:2026-08-14", "2026-08-14"],
    ["  Yesterday ", "2026-10-18"],
  ])("%s -> %s", (token, expected) => {
    expect(resolveDateToken(token as string | undefined, today)).toEqual({ ok: true, date: expected });
  });

  it("day:31 skips months without a 31st", () => {
    expect(resolveDateToken("day:31", "2026-10-19")).toEqual({ ok: true, date: "2026-08-31" });
    expect(resolveDateToken("day:30", "2026-03-10")).toEqual({ ok: true, date: "2026-01-30" });
  });

  it("crosses year and leap-day boundaries", () => {
    expect(resolveDateToken("yesterday", "2027-01-01")).toEqual({ ok: true, date: "2026-12-31" });
    expect(resolveDateToken("yesterday", "2028-03-01")).toEqual({ ok: true, date: "2028-02-29" });
  });

  it.each(["tomorrow", "weekday:funday", "days_ago:-2", "days_ago:x", "date:2026-02-30", "day:0", "day:32"])(
    "rejects %s",
    (token) => {
      expect(resolveDateToken(token, today).ok).toBe(false);
    },
  );
});

describe("checkExpenseDate", () => {
  it("rejects future dates", () => {
    expect(checkExpenseDate("2026-10-20", "2026-10-19", 60).ok).toBe(false);
  });
  it("flags dates more than 60 days back for confirmation", () => {
    expect(checkExpenseDate("2026-08-20", "2026-10-19", 60)).toEqual({ ok: true, old: false }); // 60 days
    expect(checkExpenseDate("2026-08-19", "2026-10-19", 60)).toEqual({ ok: true, old: true }); // 61 days
  });
});

describe("month helpers", () => {
  it("half-open month ranges", () => {
    expect(monthRange("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
    expect(monthRange("2026-02")).toEqual({ start: "2026-02-01", end: "2026-03-01" });
  });
  it("addMonths across years", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", 2)).toBe("2027-01");
  });
});

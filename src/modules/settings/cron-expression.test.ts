import { describe, expect, it } from "vitest";

import {
  isCronExpressionDue,
  isValidCronExpression,
  minuteKeyForDate,
  validateCronExpression,
} from "./cron-expression";

describe("cron expressions", () => {
  it.each(["0 2 * * *", "*/15 8-17 * * 1-5", "0,30 1 * * *"])(
    "accepts %s",
    (expression) => expect(isValidCronExpression(expression)).toBe(true),
  );

  it.each([
    ["* * *", "5-field"],
    ["60 * * * *", "between 0 and 59"],
    ["*/0 * * * *", "greater than 0"],
    ["5-1 * * * *", "before the end"],
    ["a * * * *", "Invalid"],
    ["1,,2 * * * *", "Invalid"],
    ["1- * * * *", "range"],
    ["*/99 * * * *", "between"],
  ])("rejects %s", (expression, expected) => {
    expect(validateCronExpression(expression)).toContain(expected);
  });

  it("matches steps, ranges, and Sunday alias 7", () => {
    const sunday = new Date(2026, 5, 28, 10, 30);
    expect(isCronExpressionDue("*/15 10 * * 7", sunday)).toBe(true);
    expect(isCronExpressionDue("31 10 * * 7", sunday)).toBe(false);
  });

  it("uses cron OR semantics when both day fields are restricted", () => {
    const mondayTheFirst = new Date(2026, 5, 1, 2, 0);
    expect(isCronExpressionDue("0 2 15 * 1", mondayTheFirst)).toBe(true);
  });

  it("throws when evaluating an invalid expression for a fixed date", () => {
    const fixed = new Date(2026, 5, 28, 10, 30);
    expect(() => isCronExpressionDue("bad expression", fixed)).toThrow(
      "Enter a 5-field cron expression, for example 0 2 * * *.",
    );
  });

  it("throws the field error when a segment is empty", () => {
    const fixed = new Date(2026, 5, 28, 10, 30);
    expect(() => isCronExpressionDue("1,,2 * * * *", fixed)).toThrow(
      "Invalid minute field.",
    );
  });

  it("produces a stable local minute key", () => {
    expect(minuteKeyForDate(new Date(2026, 0, 2, 3, 4))).toBe("2026-01-02T03:04");
  });
});

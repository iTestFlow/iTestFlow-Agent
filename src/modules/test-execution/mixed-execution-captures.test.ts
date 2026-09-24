import { describe, expect, it } from "vitest";
import { CaseCaptures, assertResult, readResultPath, substituteTestData } from "./mixed-execution-captures";

describe("case-local execution values", () => {
  it("captures scalar values and binds them without exposing values in names", () => {
    const captures = new CaseCaptures();
    captures.capture("account_id", { body: { id: 42 } }, "body.id");
    expect(captures.names()).toEqual(["account_id"]);
    expect(captures.substitute({ path: "/accounts/{{capture:account_id}}", id: "{{capture:account_id}}" }))
      .toEqual({ path: "/accounts/42", id: 42 });
    expect(() => captures.capture("object", { body: { id: { nested: true } } }, "body.id")).toThrow(/scalar/);
  });

  it("rejects missing or unsafe paths and keeps captures isolated", () => {
    expect(readResultPath({ rows: [{ id: "a" }] }, "rows[0].id")).toBe("a");
    expect(() => readResultPath({ body: {} }, "body.__proto__")).toThrow();
    expect(() => readResultPath({ body: {} }, "body.missing")).toThrow();
    expect(() => new CaseCaptures().substitute("{{capture:account_id}}")).toThrow(/unavailable/);
  });

  it("compares values deterministically and substitutes named test data", () => {
    expect(assertResult({ statusCode: 200, rows: [{ count: 3 }] }, "statusCode", "equals", 200)).toBe(true);
    expect(assertResult({ statusCode: 500 }, "statusCode", "equals", 200)).toBe(false);
    expect(assertResult({ rows: [{ count: 3 }] }, "rows[0].count", "gte", 2)).toBe(true);
    expect(substituteTestData({ password: "{{testData:Password}}" }, [{ title: "Password", value: "private-value" }]))
      .toEqual({ password: "private-value" });
  });
});

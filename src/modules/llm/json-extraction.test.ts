import { describe, expect, it } from "vitest";
import { describeJsonParseError } from "./json-extraction";

describe("describeJsonParseError", () => {
  it("returns a non-empty snippet when the parse position is beyond the candidate length", () => {
    const result = describeJsonParseError(
      "Unterminated string in JSON at position 55685 (line 914 column 48)",
      '{"summary":"short truncated output"',
    );

    expect(result.position).toBe(55685);
    expect(result.snippet).toBeTruthy();
    expect(result.message).toContain("Check the JSON near:");
    expect(result.message).not.toMatch(/Check the JSON near:\s*$/);
  });
});

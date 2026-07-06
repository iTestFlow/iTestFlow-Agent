import { describe, expect, it } from "vitest";
import {
  JsonParseError,
  describeJsonParseError,
  formatJsonParseError,
  parseJsonWithRepair,
} from "./json-extraction";

describe("parseJsonWithRepair", () => {
  describe("repairs common external-LLM damage", () => {
    it("strips trailing commas before object and array closers, including across whitespace", () => {
      expect(parseJsonWithRepair('{"items": [1, 2, 3,], "done": true,}')).toEqual({
        items: [1, 2, 3],
        done: true,
      });
      expect(parseJsonWithRepair('{"a": 1,\n  \n}')).toEqual({ a: 1 });
    });

    it("normalizes smart quotes used as string delimiters", () => {
      expect(parseJsonWithRepair("{“status”: “ok”, “note”: “it’s ready”}")).toEqual({
        status: "ok",
        note: "it's ready",
      });
    });

    it("escapes unescaped inner quotes in object string values", () => {
      expect(parseJsonWithRepair('{"quote": "He said "stop" now"}')).toEqual({
        quote: 'He said "stop" now',
      });
      // Inner quotes followed by a comma and another key must not end the string early.
      expect(parseJsonWithRepair('{"a": "the "beta" build", "b": 1}')).toEqual({
        a: 'the "beta" build',
        b: 1,
      });
    });

    it("escapes unescaped inner quotes in array string values", () => {
      expect(parseJsonWithRepair('{"list": ["say "hi" loud", "bye"]}')).toEqual({
        list: ['say "hi" loud', "bye"],
      });
    });

    it("escapes raw control characters and invalid backslash escapes inside strings", () => {
      // The TS literals contain a real newline and a lone backslash before "W".
      expect(parseJsonWithRepair('{"a": "line1\nline2", "path": "C:\\Windows"}')).toEqual({
        a: "line1\nline2",
        path: "C:\\Windows",
      });
    });

    it("quotes bare `N - Label` enum values that follow a colon", () => {
      expect(parseJsonWithRepair('{"priority": 1 - Highest, "id": 7}')).toEqual({
        priority: "1 - Highest",
        id: 7,
      });
    });
  });

  describe("does not mangle valid JSON whose values merely look damaged", () => {
    it("preserves string values containing number-dash labels", () => {
      expect(parseJsonWithRepair('{"priority": "1 - Highest"}')).toEqual({
        priority: "1 - Highest",
      });
    });

    it("preserves string values containing trailing-comma-like and closer-like text", () => {
      expect(parseJsonWithRepair('{"note": "ends with, }", "csv": "a,b,c,]"}')).toEqual({
        note: "ends with, }",
        csv: "a,b,c,]",
      });
    });

    it("preserves correctly escaped quotes inside string values", () => {
      expect(parseJsonWithRepair('{"q": "He said \\"hi\\" loudly"}')).toEqual({
        q: 'He said "hi" loudly',
      });
    });

    it("preserves smart quotes inside already-valid string values", () => {
      // Valid JSON parses on the first attempt, before delimiter normalization.
      expect(parseJsonWithRepair('{"msg": "she said “hi” and it’s fine"}')).toEqual({
        msg: "she said “hi” and it’s fine",
      });
    });

    it("repairs the real defect without corrupting damage-looking string values", () => {
      // Only the trailing commas are broken; every string value must survive verbatim.
      const raw = '{"a": "1 - Highest", "b": "keep \\"this\\" and, } text", "c": [1, 2,],}';
      expect(parseJsonWithRepair(raw)).toEqual({
        a: "1 - Highest",
        b: 'keep "this" and, } text',
        c: [1, 2],
      });
    });
  });

  describe("failure modes", () => {
    it("throws JsonParseError when the output contains no JSON at all", () => {
      expect(() => parseJsonWithRepair("  \n ")).toThrow(JsonParseError);
      expect(() => parseJsonWithRepair("")).toThrow("No JSON content found in output.");
    });

    it("does not fabricate a result from truncated JSON", () => {
      let caught: unknown;
      try {
        parseJsonWithRepair('Here you go: {"summary": "cut off mid-sentence');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(JsonParseError);
      const parseError = caught as JsonParseError;
      expect(parseError.name).toBe("JsonParseError");
      // The error carries the extracted candidate (leading prose removed) for diagnostics.
      expect(parseError.candidate).toBe('{"summary": "cut off mid-sentence');
      expect(parseError.message).toBeTruthy();
    });
  });
});

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

  it("returns generic guidance when the message carries no position", () => {
    const result = describeJsonParseError("Unexpected end of JSON input", '{"a": 1');

    expect(result.message).toBe(
      "Unexpected end of JSON input. Paste one complete JSON object from the opening { to the final }.",
    );
    expect(result.position).toBeUndefined();
    expect(result.snippet).toBeUndefined();
  });

  it("windows the snippet around an in-range position and collapses whitespace", () => {
    const candidate = "S" + "a".repeat(149) + "MARKER\n\n  after" + "b".repeat(150);
    const result = describeJsonParseError("Unexpected token in JSON at position 153", candidate);

    expect(result.position).toBe(153);
    // 80-char window on each side: includes the marker, excludes the distant start sentinel.
    expect(result.snippet).toContain("MARKER after");
    expect(result.snippet).not.toContain("S");
    expect(result.message).toContain("Check the JSON near: ");
  });

  it("omits the snippet when the candidate is empty", () => {
    const result = describeJsonParseError("Unexpected end of JSON input at position 10", "");

    expect(result.position).toBe(10);
    expect(result.snippet).toBeUndefined();
    expect(result.message).toBe("Unexpected end of JSON input at position 10");
  });
});

describe("formatJsonParseError", () => {
  it("returns only the human-readable message", () => {
    expect(formatJsonParseError("Oops", "{}")).toBe(
      "Oops. Paste one complete JSON object from the opening { to the final }.",
    );
  });
});

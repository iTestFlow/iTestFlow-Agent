import { describe, expect, it } from "vitest";

import { REDACTION_MARKER, createScrubber, scrubDeep } from "./output-scrubber";

describe("createScrubber", () => {
  it("replaces every occurrence of every scrub value", () => {
    const scrub = createScrubber(["s3cr3t", "t0ken"]);
    expect(scrub("a s3cr3t and t0ken and s3cr3t")).toBe(
      `a ${REDACTION_MARKER} and ${REDACTION_MARKER} and ${REDACTION_MARKER}`,
    );
  });

  it("replaces longer values first so suffixes cannot leak", () => {
    const scrub = createScrubber(["pass", "password123"]);
    expect(scrub("x password123 y")).toBe(`x ${REDACTION_MARKER} y`);
    expect(scrub("x password123 y")).not.toContain("123");
  });

  it("ignores short values and is identity with no values", () => {
    expect(createScrubber(["abc"])("abc abc")).toBe("abc abc");
    expect(createScrubber([])("anything")).toBe("anything");
  });
});

describe("scrubDeep", () => {
  it("scrubs string leaves in nested structures", () => {
    const scrub = createScrubber(["hunter2"]);
    const input = {
      detail: "typed hunter2",
      candidates: ["button hunter2", "link ok"],
      nested: { url: "https://x/?pw=hunter2", count: 3, flag: true, none: null },
    };
    expect(scrubDeep(input, scrub)).toEqual({
      detail: `typed ${REDACTION_MARKER}`,
      candidates: [`button ${REDACTION_MARKER}`, "link ok"],
      nested: { url: `https://x/?pw=${REDACTION_MARKER}`, count: 3, flag: true, none: null },
    });
  });
});

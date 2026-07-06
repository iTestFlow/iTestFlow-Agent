import { describe, expect, it } from "vitest";

import { countEditedById } from "./edited-count";

describe("countEditedById", () => {
  it("counts only selected records whose observable payload changed", () => {
    const original = new Map([
      ["a", { id: "a", title: "Original", tags: ["one"] }],
      ["b", { id: "b", title: "Stable", tags: [] }],
    ]);

    expect(countEditedById([
      { id: "a", title: "Edited", tags: ["one"] },
      { id: "b", title: "Stable", tags: [] },
    ], original)).toBe(1);
  });

  it("treats a newly added selected record as edited", () => {
    expect(countEditedById([{ id: "new", value: 1 }], new Map())).toBe(1);
  });

  it("ignores unselected originals", () => {
    expect(countEditedById([], new Map([["a", { id: "a" }]]))).toBe(0);
  });
});

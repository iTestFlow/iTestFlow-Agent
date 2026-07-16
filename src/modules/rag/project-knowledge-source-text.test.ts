import { describe, expect, it } from "vitest";

import {
  normalizeProjectKnowledgeSourceWhitespace,
  projectKnowledgeCanonicalSourceText,
  projectKnowledgeSourceFieldText,
} from "./project-knowledge-source-text";

describe("canonical project knowledge source text", () => {
  it("strips HTML, decodes entities, normalizes Unicode and collapses whitespace", () => {
    expect(projectKnowledgeCanonicalSourceText(
      "<p>Ａ &amp; B&nbsp;</p><div>line&#10;two &#x1F680;</div>",
      "description",
    )).toBe("A & B line two 🚀");
  });

  it("projects tags, arrays, metadata and missing values deterministically", () => {
    expect(projectKnowledgeCanonicalSourceText("one; two ;", "tags")).toBe("one; two");
    expect(projectKnowledgeCanonicalSourceText(["one", "two"], "tags")).toBe("one; two");
    expect(projectKnowledgeCanonicalSourceText(["a", "b"], "description")).toBe("a; b");
    expect(projectKnowledgeCanonicalSourceText({ z: 1, a: { y: 2 } }, "metadata"))
      .toBe('{"a":{"y":2},"z":1}');
    expect(projectKnowledgeCanonicalSourceText(null, "title")).toBe("");
  });

  it("reads the selected field through the same projection", () => {
    expect(projectKnowledgeSourceFieldText({ title: "<b>Secure</b> checkout" }, "title"))
      .toBe("Secure checkout");
    expect(normalizeProjectKnowledgeSourceWhitespace("  one\n\t two  ")).toBe("one two");
  });
});

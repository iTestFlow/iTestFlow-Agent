import { describe, expect, it } from "vitest";

import { estimateTokens } from "@/modules/llm/token-estimate";

describe("estimateTokens", () => {
  it("keeps the ASCII rate at 4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("charges CJK text one token per character", () => {
    // Real BPEs encode BMP CJK at roughly 0.7-1.5 tokens per character; one per
    // character is the conservative middle, where the old flat /4 undercounted 4x.
    expect(estimateTokens("测".repeat(100))).toBe(100);
  });

  it("charges Arabic text at 2 chars per token", () => {
    expect(estimateTokens("م".repeat(100))).toBe(50);
  });

  it("sums bands for mixed-script text", () => {
    expect(estimateTokens("x".repeat(200) + "测".repeat(100))).toBe(150);
  });

  it("counts an emoji surrogate pair as two dense units", () => {
    expect(estimateTokens("😀")).toBe(2);
  });
});

import { describe, expect, it } from "vitest";

import { splitSummaryKeyPoints } from "./summary-key-points";

describe("splitSummaryKeyPoints", () => {
  it("returns an empty paragraph for empty input", () => {
    expect(splitSummaryKeyPoints("")).toEqual({ kind: "paragraph", text: "" });
  });

  it("returns an empty paragraph for whitespace-only input", () => {
    expect(splitSummaryKeyPoints("   \n  ")).toEqual({ kind: "paragraph", text: "" });
  });

  it("keeps a single sentence as a paragraph", () => {
    const result = splitSummaryKeyPoints("Coverage is strong across the reviewed points.");
    expect(result).toEqual({ kind: "paragraph", text: "Coverage is strong across the reviewed points." });
  });

  it("splits two clean sentences into points and keeps terminal punctuation", () => {
    const result = splitSummaryKeyPoints("Strong broad coverage exists. Quote expiry boundary remains a risk.");
    expect(result).toEqual({
      kind: "points",
      points: ["Strong broad coverage exists.", "Quote expiry boundary remains a risk."],
    });
  });

  it("splits three sentences separated by newlines and trims them", () => {
    const result = splitSummaryKeyPoints("First sentence here.\nSecond sentence here.\nThird sentence here.\n");
    expect(result).toEqual({
      kind: "points",
      points: ["First sentence here.", "Second sentence here.", "Third sentence here."],
    });
  });

  it("does not split on decimals", () => {
    const result = splitSummaryKeyPoints("Coverage is 85.5% overall. Mobile responsiveness remains weak.");
    expect(result).toEqual({
      kind: "points",
      points: ["Coverage is 85.5% overall.", "Mobile responsiveness remains weak."],
    });
  });

  it("does not split on known abbreviations", () => {
    const result = splitSummaryKeyPoints("Check edge cases, e.g. expiry boundary. Then review automation gaps.");
    expect(result).toEqual({
      kind: "points",
      points: ["Check edge cases, e.g. expiry boundary.", "Then review automation gaps."],
    });
  });

  it("does not emit a trailing empty point when the last sentence lacks a period", () => {
    const result = splitSummaryKeyPoints("Coverage is strong overall. Mobile responsiveness needs work");
    expect(result).toEqual({
      kind: "points",
      points: ["Coverage is strong overall.", "Mobile responsiveness needs work"],
    });
  });

  it("falls back to a paragraph when fragments are too short to be real sentences", () => {
    const result = splitSummaryKeyPoints("OK. Go now please.");
    expect(result).toEqual({ kind: "paragraph", text: "OK. Go now please." });
  });
});

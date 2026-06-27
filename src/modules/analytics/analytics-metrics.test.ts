import { describe, expect, it } from "vitest";

import {
  calculateCycleSaved,
  calculateElapsedMinutes,
  calculateEstimatedSavings,
  calculateLaborSaved,
  calculateRate,
  isRealizedValue,
} from "./analytics-metrics";

describe("stakeholder value calculations", () => {
  it("subtracts actual elapsed time from the configured manual baseline", () => {
    expect(calculateEstimatedSavings(90, 22.5)).toBe(67.5);
  });

  it("never reports negative estimated savings", () => {
    expect(calculateEstimatedSavings(30, 45)).toBe(0);
  });

  it("labor saved subtracts review effort from the manual baseline", () => {
    expect(calculateLaborSaved(90, 15)).toBe(75);
  });

  it("labor saved is floored at zero when review exceeds the manual baseline", () => {
    expect(calculateLaborSaved(20, 30)).toBe(0);
  });

  it("cycle-time saved also subtracts LLM generation time", () => {
    expect(calculateCycleSaved(90, 10, 15)).toBe(65);
  });

  it("cycle-time saved collapses to labor saved when LLM time is unknown", () => {
    expect(calculateCycleSaved(90, null, 15)).toBe(calculateLaborSaved(90, 15));
  });

  it("cycle-time saved is floored at zero", () => {
    expect(calculateCycleSaved(20, 10, 15)).toBe(0);
  });

  it("calculates elapsed workflow minutes from stored timestamps", () => {
    expect(calculateElapsedMinutes(
      "2026-06-12T18:00:00.000Z",
      "2026-06-12T18:05:30.000Z",
    )).toBe(5.5);
  });

  it("does not return a negative or invalid elapsed duration", () => {
    expect(calculateElapsedMinutes(
      "2026-06-12T18:05:00.000Z",
      "2026-06-12T18:00:00.000Z",
    )).toBe(0);
    expect(calculateElapsedMinutes("invalid", "also-invalid")).toBeNull();
  });

  it("returns no rate when there is no denominator", () => {
    expect(calculateRate(0, 0)).toBeNull();
  });

  it("counts published or selected output as realized value", () => {
    expect(isRealizedValue({ itemsPublished: 2 })).toBe(true);
    expect(isRealizedValue({ itemsSelected: 1 })).toBe(true);
  });

  it("does not count abandoned generated output as realized value", () => {
    expect(isRealizedValue({ itemsPublished: 0, itemsSelected: 0 })).toBe(false);
  });

  it("counts completed automation as realized value", () => {
    expect(isRealizedValue({ automationCompleted: true })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { __testables } from "./dashboard-analytics.service";

const { resolveDateRange } = __testables;

describe("resolveDateRange", () => {
  it("honors a valid custom range and rejects an inverted one", () => {
    expect(resolveDateRange({ datePreset: "custom", from: "2026-06-01", to: "2026-06-07" }, [])).toEqual({
      preset: "custom",
      from: "2026-06-01",
      to: "2026-06-07",
    });
    // from > to is invalid -> falls back to the default window rather than the bad range.
    const inverted = resolveDateRange({ datePreset: "custom", from: "2026-06-07", to: "2026-06-01" }, []);
    expect(inverted.from <= inverted.to).toBe(true);
  });

  it("spans the inclusive number of local days for a preset", () => {
    const range = resolveDateRange({ datePreset: "7d" }, []);
    const fromMs = new Date(`${range.from}T00:00:00`).getTime();
    const toMs = new Date(`${range.to}T00:00:00`).getTime();
    expect(Math.round((toMs - fromMs) / 86_400_000)).toBe(6); // 7 inclusive days
  });
});

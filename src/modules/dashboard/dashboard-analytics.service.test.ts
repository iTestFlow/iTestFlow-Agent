import { describe, expect, it } from "vitest";

import { __testables } from "./dashboard-analytics.service";

const { buildBugTrend, findReopenedBugIds, resolveDateRange } = __testables;

// Noon-UTC timestamps so an event's local calendar day stays inside a wide range for
// any realistic host timezone. Assertions sum across the trend (not a specific bucket),
// so they are independent of the runner's timezone.
const at = (day: string) => `${day}T12:00:00.000Z`;
const sum = (trend: ReturnType<typeof buildBugTrend>, key: string) =>
  trend.reduce((acc, point) => {
    const value = (point as Record<string, unknown>)[key];
    return acc + (typeof value === "number" ? value : 0);
  }, 0);

const FROM = "2026-06-01";
const TO = "2026-06-10";

describe("buildBugTrend", () => {
  it("counts opened and critical/high-opened bugs on their created day", () => {
    const bugs = [
      { id: "1", createdDate: at("2026-06-05"), severity: "1 - Critical", state: "Active", closedDate: null },
      { id: "2", createdDate: at("2026-06-05"), severity: "3 - Medium", state: "Active", closedDate: null },
    ] as unknown as Parameters<typeof buildBugTrend>[2];
    const trend = buildBugTrend(FROM, TO, bugs, []);
    expect(sum(trend, "opened")).toBe(2);
    expect(sum(trend, "criticalHighOpened")).toBe(1);
  });

  it("counts a close only when the bug is currently closed (no phantom close on reopened bugs)", () => {
    const bugs = [
      // Closed now, ClosedDate in range -> one close event.
      { id: "1", createdDate: at("2026-06-03"), severity: "2 - High", state: "Closed", closedDate: at("2026-06-08") },
      // Reopened: open now, but Azure retained a ClosedDate -> must NOT emit a phantom close.
      { id: "2", createdDate: at("2026-06-03"), severity: "2 - High", state: "Active", closedDate: at("2026-06-05") },
    ] as unknown as Parameters<typeof buildBugTrend>[2];
    const trend = buildBugTrend(FROM, TO, bugs, []);
    expect(sum(trend, "closed")).toBe(1);
  });

  it("derives closed and reopened events from revision state transitions", () => {
    const revisions = [
      { workItemId: "9", revision: 1, state: "Active", revisedDate: at("2026-06-03") },
      { workItemId: "9", revision: 2, state: "Closed", revisedDate: at("2026-06-04") },
      { workItemId: "9", revision: 3, state: "Active", revisedDate: at("2026-06-06") },
    ] as unknown as Parameters<typeof buildBugTrend>[3];
    const trend = buildBugTrend(FROM, TO, [], revisions);
    expect(sum(trend, "closed")).toBe(1);
    expect(sum(trend, "reopened")).toBe(1);
  });
});

describe("findReopenedBugIds", () => {
  it("flags only bugs that transitioned from a closed back to an open state", () => {
    const revisions = [
      { workItemId: "9", revision: 1, state: "Active" },
      { workItemId: "9", revision: 2, state: "Closed" },
      { workItemId: "9", revision: 3, state: "Active" },
      { workItemId: "10", revision: 1, state: "New" },
      { workItemId: "10", revision: 2, state: "Closed" },
    ] as unknown as Parameters<typeof findReopenedBugIds>[0];
    const ids = findReopenedBugIds(revisions);
    expect(ids.has("9")).toBe(true);
    expect(ids.has("10")).toBe(false);
  });
});

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

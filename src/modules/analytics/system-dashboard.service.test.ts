import { describe, expect, it } from "vitest";

import {
  buildSystemDashboardAdoption,
  formatSystemDashboardUserLabel,
} from "./system-dashboard.service";

describe("system dashboard pure metrics", () => {
  it("chooses a safe user label", () => {
    expect(formatSystemDashboardUserLabel({
      id: "user-1",
      displayName: " QA Owner ",
      emailOrUniqueName: "qa@example.com",
    })).toBe("QA Owner");
    expect(formatSystemDashboardUserLabel({
      id: "user-2",
      displayName: " ",
      emailOrUniqueName: "qa@example.com",
    })).toBe("qa@example.com");
  });

  it("counts users, local active days, runs, and the most-used feature", () => {
    const result = buildSystemDashboardAdoption([
      { user_id: "a", workflow_type: "test_case_design", started_at: "2026-06-01T09:00:00Z" },
      { user_id: "b", workflow_type: "requirements_analysis", started_at: "2026-06-02T09:00:00Z" },
      { user_id: "a", workflow_type: "test_case_design", started_at: "2026-06-02T12:00:00Z" },
    ]);
    expect(result).toMatchObject({
      activeUsers: 2,
      activeDays: 2,
      workflowRuns: 3,
    });
    expect(result.mostUsedFeature).not.toBeNull();
  });

  it("counts multiple same-day runs for one user as one active day", () => {
    const result = buildSystemDashboardAdoption([
      { user_id: "a", workflow_type: "requirements_analysis", started_at: "2026-06-01T09:00:00Z" },
      { user_id: "a", workflow_type: "test_case_design", started_at: "2026-06-01T15:00:00Z" },
    ]);
    expect(result).toMatchObject({
      activeUsers: 1,
      activeDays: 1,
      workflowRuns: 2,
    });
  });

  it("returns zero active days when there are no analytics rows", () => {
    const result = buildSystemDashboardAdoption([]);
    expect(result).toMatchObject({
      activeUsers: 0,
      activeDays: 0,
      workflowRuns: 0,
    });
    expect(result.mostUsedFeature).toBeNull();
  });
});

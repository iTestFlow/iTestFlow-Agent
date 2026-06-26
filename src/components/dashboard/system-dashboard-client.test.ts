import { describe, expect, it } from "vitest";

import { adoptionActivityMetric } from "@/components/dashboard/system-dashboard-adoption-metrics";

describe("system dashboard adoption card selection", () => {
  const adoption = {
    activeUsers: 3,
    activeDays: 5,
    workflowRuns: 8,
    mostUsedFeature: "Test Case Design",
  };

  it("shows Active Users for team-wide scope", () => {
    const [title, value, description] = adoptionActivityMetric({
      adoption,
      effectiveScope: { mode: "team", label: "All users", userId: null },
    });

    expect(title).toBe("Active Users");
    expect(value).toBe(3);
    expect(description).toBe("Distinct recorded workflow users.");
  });

  it("shows Active Days for member/my activity scope", () => {
    const [title, value, description] = adoptionActivityMetric({
      adoption,
      effectiveScope: { mode: "mine", label: "My activity", userId: "user_a" },
    });

    expect(title).toBe("Active Days");
    expect(value).toBe(5);
    expect(description).toBe("Days with at least one recorded workflow run.");
  });

  it("shows Active Days for owner/admin single-user scope", () => {
    const [title, value] = adoptionActivityMetric({
      adoption,
      effectiveScope: { mode: "user", label: "Mahmoud ElSharkawy", userId: "user_b" },
    });

    expect(title).toBe("Active Days");
    expect(value).toBe(5);
  });
});

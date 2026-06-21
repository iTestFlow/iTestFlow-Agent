import { describe, expect, it } from "vitest";

import {
  buildExecutionRows,
  buildRequirementRows,
  calculatePercentage,
  calculateReleaseReadiness,
  isOpenBugState,
  isResolvedBugState,
  normalizeSeverity,
  normalizeTestOutcome,
} from "./dashboard-metrics";

describe("dashboard metric normalization", () => {
  it("normalizes Azure severity and outcome variants", () => {
    expect(normalizeSeverity("1 - Critical")).toBe("Critical");
    expect(normalizeSeverity("2 - High")).toBe("High");
    expect(normalizeTestOutcome("Not Applicable")).toBe("skipped");
    expect(normalizeTestOutcome("Unspecified")).toBe("not_run");
    expect(normalizeTestOutcome("Blocked")).toBe("blocked");
  });

  it("returns null percentages when the denominator is empty", () => {
    expect(calculatePercentage(0, 0)).toBeNull();
    expect(calculatePercentage(9, 10)).toBe(90);
    expect(calculatePercentage(1, 3)).toBe(33.3);
  });
});

describe("bug state classification", () => {
  it("treats standard closed/done states as not open", () => {
    for (const state of ["Closed", "Done", "Completed", "Removed", "Rejected"]) {
      expect(isOpenBugState(state)).toBe(false);
    }
  });

  it("treats active/new/resolved states as open", () => {
    for (const state of ["New", "Active", "Committed", "Approved", "Resolved", "Reopened"]) {
      expect(isOpenBugState(state)).toBe(true);
    }
  });

  it("classifies decorated closed states by their leading word", () => {
    expect(isOpenBugState("Closed - Duplicate")).toBe(false);
    expect(isOpenBugState("Done (Verified)")).toBe(false);
  });

  it("does not misclassify negated states that merely contain a closed token", () => {
    expect(isOpenBugState("Not Done")).toBe(true);
    expect(isOpenBugState("Not Completed")).toBe(true);
  });

  it("detects resolved / retest-pending states without false positives", () => {
    expect(isResolvedBugState("Resolved")).toBe(true);
    expect(isResolvedBugState("Fixed")).toBe(true);
    expect(isResolvedBugState("Ready for Retest")).toBe(true);
    expect(isResolvedBugState("Ready to Test")).toBe(true);
    expect(isResolvedBugState("Not Fixed")).toBe(false);
    expect(isResolvedBugState("Active")).toBe(false);
  });
});

describe("dashboard execution and coverage", () => {
  it("groups execution points and excludes skipped outcomes from pass rate", () => {
    const rows = buildExecutionRows([
      { id: "1", title: "A", module: "Checkout", outcome: "passed" },
      { id: "2", title: "B", module: "Checkout", outcome: "failed" },
      { id: "3", title: "C", module: "Checkout", outcome: "skipped" },
      { id: "4", title: "D", module: "Search", outcome: "not_run" },
    ]);
    expect(rows.find((row) => row.module === "Checkout")).toMatchObject({
      total: 3,
      executed: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      passRate: 50,
      status: "critical",
    });
  });

  it("marks missing high-priority requirement coverage as high risk", () => {
    const rows = buildRequirementRows([
      {
        id: "101",
        title: "Critical checkout requirement",
        priority: 1,
        module: "Checkout",
        acceptanceCriteria: "",
        linkedTestCaseIds: [],
      },
      {
        id: "102",
        title: "Covered search requirement",
        priority: 3,
        module: "Search",
        acceptanceCriteria: "Given...",
        linkedTestCaseIds: ["501"],
      },
    ], new Map([["501", ["passed"]]]));
    expect(rows[0]).toMatchObject({ coverageStatus: "not_covered", riskStatus: "critical" });
    expect(rows[1]).toMatchObject({ coverageStatus: "covered", executionHealth: "passing", riskStatus: "low", passed: 1 });
  });

  it("keeps coverage separate from failed execution health", () => {
    const [row] = buildRequirementRows([{
      id: "103",
      title: "Covered but failing",
      priority: 2,
      module: "Quotes",
      acceptanceCriteria: "Given...",
      linkedTestCaseIds: ["502", "503"],
    }], new Map([["502", ["passed"]], ["503", ["failed"]]]));
    expect(row).toMatchObject({
      coverageStatus: "covered",
      executionHealth: "mixed",
      riskStatus: "high",
    });
  });

  it("does not flag a mostly-passing module with a couple of blocked tests as critical", () => {
    const rows = buildExecutionRows([
      ...Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, title: "T", module: "Payments", outcome: "passed" as const })),
      { id: "b1", title: "B1", module: "Payments", outcome: "blocked" },
      { id: "b2", title: "B2", module: "Payments", outcome: "blocked" },
    ]);
    expect(rows[0]).toMatchObject({ module: "Payments", passed: 100, blocked: 2, status: "medium" });
  });

  it("still flags a heavily blocked module as critical", () => {
    const rows = buildExecutionRows([
      { id: "p1", title: "T", module: "Payments", outcome: "passed" },
      { id: "p2", title: "T", module: "Payments", outcome: "passed" },
      ...Array.from({ length: 8 }, (_, index) => ({ id: `b${index}`, title: "B", module: "Payments", outcome: "blocked" as const })),
    ]);
    expect(rows[0].status).toBe("critical");
  });

  it("allows a clean, covered, passing P2 requirement to be low risk", () => {
    const [row] = buildRequirementRows([{
      id: "201",
      title: "Healthy P2 requirement",
      priority: 2,
      module: "Search",
      acceptanceCriteria: "Given...",
      linkedTestCaseIds: ["601"],
    }], new Map([["601", ["passed"]]]));
    expect(row).toMatchObject({ coverageStatus: "covered", executionHealth: "passing", riskStatus: "low" });
  });

  it("reports unknown execution health when linked tests are all skipped", () => {
    const [row] = buildRequirementRows([{
      id: "202",
      title: "Only skipped tests",
      priority: 3,
      module: "Search",
      acceptanceCriteria: "Given...",
      linkedTestCaseIds: ["602"],
    }], new Map([["602", ["skipped", "skipped"]]]));
    expect(row).toMatchObject({ coverageStatus: "covered", executionHealth: "unknown" });
  });
});

describe("release readiness gates", () => {
  const healthy = {
    executionAvailable: true,
    bugsAvailable: true,
    coverageAvailable: true,
    executionPercentage: 96,
    passRate: 98,
    openCriticalBugs: 0,
    openHighBugs: 0,
    blockedTests: 0,
    highRiskUncoveredRequirements: 0,
    retestPending: 0,
  };

  it("returns Ready only when every core source and threshold is healthy", () => {
    expect(calculateReleaseReadiness(healthy).status).toBe("ready");
  });

  it.each([
    [{ openCriticalBugs: 1 }, "critical bug"],
    [{ openHighBugs: 3 }, "high severity"],
    [{ passRate: 79 }, "pass rate"],
    [{ blockedTests: 5 }, "blocked"],
  ])("returns Not Ready for a critical balanced gate", (override, reason) => {
    const result = calculateReleaseReadiness({ ...healthy, ...override });
    expect(result.status).toBe("not_ready");
    expect(result.summary.toLowerCase()).toContain(String(reason).toLowerCase());
  });

  it("returns At Risk for lesser misses", () => {
    expect(calculateReleaseReadiness({ ...healthy, openHighBugs: 1 }).status).toBe("at_risk");
    expect(calculateReleaseReadiness({ ...healthy, executionPercentage: 89 }).status).toBe("at_risk");
    expect(calculateReleaseReadiness({ ...healthy, retestPending: 1 }).status).toBe("at_risk");
  });

  it("returns Unknown when core data is absent and no available metric proves risk", () => {
    expect(calculateReleaseReadiness({
      ...healthy,
      executionAvailable: false,
      bugsAvailable: false,
      coverageAvailable: false,
      executionPercentage: null,
      passRate: null,
    }).status).toBe("unknown");
  });

  it("yields a numeric score when ready but a null score whenever status is unknown", () => {
    expect(typeof calculateReleaseReadiness(healthy).score).toBe("number");
    // Execution-only data, all healthy: status is unknown (bugs/coverage unmeasured), so no misleading 100 score.
    const executionOnly = calculateReleaseReadiness({
      ...healthy,
      bugsAvailable: false,
      coverageAvailable: false,
    });
    expect(executionOnly.status).toBe("unknown");
    expect(executionOnly.score).toBeNull();
  });
});

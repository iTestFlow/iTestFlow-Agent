import { describe, expect, it } from "vitest";

import type { AzureIteration, Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import type { WorkbenchFilters } from "@/types/my-workbench-dashboard";
import {
  buildMyWorkbenchAnalyticsModel,
  normalizeWorkbenchState,
} from "./my-workbench-metrics";

const iteration: AzureIteration = {
  id: "sprint-1",
  name: "Sprint 1",
  path: "Project\\Sprint 1",
  startDate: "2026-06-15T00:00:00.000Z",
  finishDate: "2026-06-26T00:00:00.000Z",
};

const defaultFilters: WorkbenchFilters = {
  sprintMode: "current",
  iterationPath: null,
  workItemTypes: [],
  statusGroups: ["To Do", "Active", "Blocked / Waiting", "Review / Testing", "Other / Unmapped"],
  priority: "all",
  areaPath: null,
  includeCompleted: false,
  includeBacklog: false,
};

function item(overrides: Partial<Requirement>): Requirement {
  return {
    id: overrides.id ?? "1",
    azureProjectId: "project-id",
    workItemType: overrides.workItemType ?? "QA Task",
    title: overrides.title ?? "Assigned work",
    state: overrides.state ?? "Active",
    assignedTo: "Ada Lovelace",
    iterationPath: iteration.path,
    areaPath: "Project",
    tags: [],
    ...overrides,
  };
}

function build(items: Requirement[], filters: WorkbenchFilters = defaultFilters) {
  return buildMyWorkbenchAnalyticsModel({
    items,
    parentsById: new Map(),
    filters,
    iterations: [iteration],
    buildWorkItemUrl: (id) => `https://dev.azure.com/org/project/_workitems/edit/${id}`,
    today: new Date(2026, 5, 20),
  });
}

describe("workbench state normalization", () => {
  it("keeps custom states visible through normalized dashboard groups", () => {
    expect(normalizeWorkbenchState("QA In Progress")).toBe("Review / Testing");
    expect(normalizeWorkbenchState("Pending Clarification")).toBe("Blocked / Waiting");
    expect(normalizeWorkbenchState("Ready for Dev")).toBe("To Do");
    expect(normalizeWorkbenchState("Mystery Workflow")).toBe("Other / Unmapped");
  });

  it("classifies custom completed states through normalized Done", () => {
    expect(normalizeWorkbenchState("Cancelled")).toBe("Done");
    expect(normalizeWorkbenchState("Closed - Duplicate")).toBe("Done");
  });
});

describe("workbench model", () => {
  it("includes custom work item types and unmapped states while excluding Done by default", () => {
    const model = build([
      item({ id: "1", workItemType: "QA Task", state: "QA In Progress", remainingWork: 4 }),
      item({ id: "2", workItemType: "Support Ticket", state: "Cancelled", remainingWork: 5 }),
      item({ id: "3", workItemType: "Investigation", state: "Mystery Workflow", remainingWork: 2 }),
    ]);

    expect(model.focusList.map((row) => row.id)).toEqual(["3", "1"]);
    expect(model.focusList.map((row) => row.type)).toContain("Investigation");
    expect(model.charts.workItemsByType.map((row) => row.name)).toEqual(["Investigation", "QA Task"]);
    expect(model.counts.completedExcluded).toBe(1);
  });

  it("includes Done work when includeCompleted is enabled and Done is selected", () => {
    const model = build([
      item({ id: "1", state: "Active", remainingWork: 2 }),
      item({ id: "2", state: "Closed", remainingWork: 0, completedWork: 3 }),
    ], {
      ...defaultFilters,
      includeCompleted: true,
      statusGroups: [...defaultFilters.statusGroups, "Done"],
    });

    expect(model.focusList.map((row) => row.id)).toContain("2");
    expect(model.counts.completedExcluded).toBe(0);
  });

  it("marks missing remaining work as unestimated without dropping the item", () => {
    const model = build([
      item({ id: "1", state: "Active", remainingWork: undefined }),
    ]);

    expect(model.focusList[0].focusBadges).toContain("No Estimate");
    expect(model.cards.find((card) => card.key === "unestimatedWork")).toMatchObject({
      value: "1 item",
      subtitle: "Missing Remaining Work",
    });
  });

  it("sorts blocked and overdue work above ordinary active work", () => {
    const model = build([
      item({ id: "1", state: "Active", priority: 3, remainingWork: 2 }),
      item({ id: "2", state: "Blocked", priority: 4, remainingWork: 1 }),
      item({ id: "3", state: "Active", priority: 4, dueDate: "2026-06-18T00:00:00.000Z", remainingWork: 1 }),
    ]);

    expect(model.focusList.map((row) => row.id).slice(0, 2)).toEqual(["2", "3"]);
  });

  it("falls back to the most recently started iteration and filters by path, not date range", () => {
    const oldSprint: AzureIteration = {
      id: "old",
      name: "Sprint Old",
      path: "Project\\Sprint Old",
      startDate: "2026-05-01T00:00:00.000Z",
      finishDate: "2026-05-10T00:00:00.000Z",
    };
    const newerSprint: AzureIteration = {
      id: "newer",
      name: "Sprint Newer",
      path: "Project\\Sprint Newer",
      startDate: "2026-06-01T00:00:00.000Z",
      finishDate: "2026-06-10T00:00:00.000Z",
    };
    const model = buildMyWorkbenchAnalyticsModel({
      items: [
        item({ id: "1", iterationPath: oldSprint.path }),
        item({ id: "2", iterationPath: newerSprint.path }),
      ],
      parentsById: new Map(),
      filters: defaultFilters,
      iterations: [oldSprint, newerSprint],
      buildWorkItemUrl: (id) => `https://dev.azure.com/org/project/_workitems/edit/${id}`,
      today: new Date(2026, 6, 20),
    });

    expect(model.selectedSprint.path).toBe(newerSprint.path);
    expect(model.focusList.map((row) => row.id)).toEqual(["2"]);
    expect(model.warnings.some((warning) => warning.includes("No matching sprint dates"))).toBe(false);
  });
});

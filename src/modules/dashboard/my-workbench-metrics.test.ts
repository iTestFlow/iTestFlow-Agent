import { describe, expect, it } from "vitest";

import type { AzureIteration, Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import type { WorkbenchFilters } from "@/types/my-workbench-dashboard";
import {
  NO_PARENT_FILTER_VALUE,
  buildMyWorkbenchAnalyticsModel,
  buildWorkbenchMetadata,
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
  states: [],
  parentIds: [],
  priority: "all",
  areaPath: null,
  includeCompleted: false,
  includeBacklog: false,
};

type Parent = { id: string; title: string; url: string | null };

const parentA: Parent = { id: "100", title: "Checkout parent story", url: "https://dev.azure.com/org/project/_workitems/edit/100" };
const parentB: Parent = { id: "200", title: "Payments parent story", url: "https://dev.azure.com/org/project/_workitems/edit/200" };

function item(overrides: Partial<Requirement>): Requirement {
  return {
    id: overrides.id ?? "1",
    azureProjectId: "project-id",
    workItemType: overrides.workItemType ?? "QA Task",
    title: overrides.title ?? "Assigned work",
    state: overrides.state === undefined ? "Active" : overrides.state,
    assignedTo: "Ada Lovelace",
    iterationPath: iteration.path,
    areaPath: "Project",
    tags: [],
    ...overrides,
  };
}

function build(
  items: Requirement[],
  filters: WorkbenchFilters = defaultFilters,
  parents: Parent[] = [],
) {
  return buildMyWorkbenchAnalyticsModel({
    items,
    parentsById: new Map(parents.map((parent) => [parent.id, parent])),
    filters,
    iterations: [iteration],
    buildWorkItemUrl: (id) => `https://dev.azure.com/org/project/_workitems/edit/${id}`,
    today: new Date(2026, 5, 20),
  });
}

describe("workbench raw state model", () => {
  it("keeps raw custom states in focus rows and remaining-work status chart", () => {
    const model = build([
      item({ id: "1", workItemType: "QA Task", state: "QA In Progress", remainingWork: 4 }),
      item({ id: "2", workItemType: "Investigation", state: "Mystery Workflow", remainingWork: 2 }),
    ]);

    expect(model.focusList.map((row) => row.state)).toEqual(["QA In Progress", "Mystery Workflow"]);
    expect(model.charts.remainingWorkByStatus).toEqual([
      { name: "QA In Progress", key: "QA In Progress", value: 4 },
      { name: "Mystery Workflow", key: "Mystery Workflow", value: 2 },
    ]);
    expect(JSON.stringify(model)).not.toContain("Other / Unmapped");
    expect(JSON.stringify(model)).not.toContain("Review / Testing");
  });

  it("excludes only exact Closed by default", () => {
    const model = build([
      item({ id: "1", state: "Closed", remainingWork: 0 }),
      item({ id: "2", state: "Done", remainingWork: 1 }),
      item({ id: "3", state: "Resolved", remainingWork: 1 }),
      item({ id: "4", state: "Closed - Duplicate", remainingWork: 1 }),
      item({ id: "5", state: "Cancelled", remainingWork: 1 }),
    ]);

    expect(model.focusList.map((row) => row.id)).not.toContain("1");
    expect(model.focusList.map((row) => row.state).sort()).toEqual(["Cancelled", "Closed - Duplicate", "Done", "Resolved"]);
    expect(model.counts.completedExcluded).toBe(1);
  });

  it("includes exact Closed when includeCompleted is enabled", () => {
    const model = build([
      item({ id: "1", state: "Active", remainingWork: 2 }),
      item({ id: "2", state: "Closed", remainingWork: 0, completedWork: 3 }),
    ], {
      ...defaultFilters,
      includeCompleted: true,
    });

    expect(model.focusList.map((row) => row.id)).toContain("2");
    expect(model.charts.remainingWorkByStatus.map((row) => row.name)).toContain("Active");
    expect(model.counts.completedExcluded).toBe(0);
  });

  it("filters by exact raw state values", () => {
    const model = build([
      item({ id: "1", state: "Ready for UAT", remainingWork: 2 }),
      item({ id: "2", state: "Ready for QA", remainingWork: 2 }),
    ], {
      ...defaultFilters,
      states: ["Ready for UAT"],
    });

    expect(model.focusList.map((row) => row.id)).toEqual(["1"]);
    expect(model.charts.remainingWorkByStatus.map((row) => row.name)).toEqual(["Ready for UAT"]);
  });

  it("filters by parent and supports no-parent items", () => {
    const parentModel = build([
      item({ id: "1", parentLinks: [parentA.id], remainingWork: 2 }),
      item({ id: "2", parentLinks: [parentB.id], remainingWork: 2 }),
      item({ id: "3", parentLinks: [], remainingWork: 2 }),
    ], {
      ...defaultFilters,
      parentIds: [parentA.id],
    }, [parentA, parentB]);
    const noParentModel = build([
      item({ id: "1", parentLinks: [parentA.id], remainingWork: 2 }),
      item({ id: "2", parentLinks: [], remainingWork: 2 }),
    ], {
      ...defaultFilters,
      parentIds: [NO_PARENT_FILTER_VALUE],
    }, [parentA]);

    expect(parentModel.focusList.map((row) => row.id)).toEqual(["1"]);
    expect(parentModel.focusList[0].parent).toMatchObject({ id: parentA.id, title: parentA.title });
    expect(noParentModel.focusList.map((row) => row.id)).toEqual(["2"]);
  });

  it("combines work item type, state, and parent filters with AND behavior", () => {
    const model = build([
      item({ id: "1", workItemType: "Bug", state: "Active", parentLinks: [parentA.id], remainingWork: 2 }),
      item({ id: "2", workItemType: "Task", state: "Active", parentLinks: [parentA.id], remainingWork: 2 }),
      item({ id: "3", workItemType: "Bug", state: "Ready for QA", parentLinks: [parentA.id], remainingWork: 2 }),
      item({ id: "4", workItemType: "Bug", state: "Active", parentLinks: [parentB.id], remainingWork: 2 }),
    ], {
      ...defaultFilters,
      workItemTypes: ["Bug"],
      states: ["Active"],
      parentIds: [parentA.id],
    }, [parentA, parentB]);

    expect(model.focusList.map((row) => row.id)).toEqual(["1"]);
  });

  it("does not apply blocker-specific cards, badges, or sprint counts", () => {
    const model = build([
      item({ id: "1", state: "Blocked", tags: ["Blocked"], remainingWork: 2 }),
    ]);

    expect(model.cards.map((card) => card.key)).not.toContain("blockedWaiting");
    expect(model.focusList[0].focusBadges).not.toContain("Blocked");
    expect(model.assignedBySprint[0]).not.toHaveProperty("blocked");
    expect(JSON.stringify(model)).not.toContain("Blocked / Waiting");
  });

  it("marks missing remaining work as unestimated without dropping the item", () => {
    const model = build([
      item({ id: "1", state: "Active", remainingWork: undefined }),
    ]);

    expect(model.focusList[0].focusBadges).toContain("No Estimate");
    expect(model.cards.find((card) => card.key === "remainingWork")).toMatchObject({
      title: "Remaining Work",
      value: "0h remaining",
      subtitle: "1 item missing estimates",
    });
    expect(model.cards.find((card) => card.key === "missingEstimates")).toMatchObject({
      title: "Missing Estimates",
      value: "1 item",
      subtitle: "100% of open work",
    });
  });

  it("builds distinct KPI cards for workload, effort, and missing estimates", () => {
    const model = build([
      item({ id: "1", state: "Active", priority: 1, remainingWork: 5, completedWork: 2 }),
      item({ id: "2", state: "Active", remainingWork: undefined }),
    ]);

    expect(model.cards.map((card) => card.key)).toEqual(["openWork", "remainingWork", "missingEstimates"]);
    expect(model.cards.find((card) => card.key === "openWork")).toMatchObject({
      title: "Open Work",
      value: "2 items",
      subtitle: "Selected sprint scope",
    });
    expect(model.cards.find((card) => card.key === "remainingWork")).toMatchObject({
      title: "Remaining Work",
      value: "5h remaining",
      subtitle: "1 item missing estimates",
    });
    expect(model.cards.find((card) => card.key === "missingEstimates")).toMatchObject({
      title: "Missing Estimates",
      value: "1 item",
      subtitle: "50% of open work",
    });
  });

  it("falls back to the most recently started sprint and filters by path, not date range", () => {
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

describe("workbench filter metadata", () => {
  it("builds raw state and scoped parent options", () => {
    const metadata = buildWorkbenchMetadata({
      iterations: [iteration],
      areas: [{ path: "Project" }],
      states: ["Active", "Ready for UAT"],
      scopedItems: [
        item({ id: "1", state: "Custom Workflow", parentLinks: [parentA.id] }),
        item({ id: "2", state: "", parentLinks: [] }),
      ],
      parentsById: new Map([[parentA.id, parentA]]),
      today: new Date(2026, 5, 20),
    });

    expect(metadata.states.map((option) => option.value)).toEqual(["Active", "Custom Workflow", "Ready for UAT", "Unknown"]);
    expect(metadata.parents).toEqual([
      { value: NO_PARENT_FILTER_VALUE, label: "No parent" },
      { value: parentA.id, label: `#${parentA.id} ${parentA.title}`, description: parentA.title },
    ]);
  });
});

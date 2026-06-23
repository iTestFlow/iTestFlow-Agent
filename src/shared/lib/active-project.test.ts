import { describe, expect, it } from "vitest";

import {
  projectMatchesActiveScope,
  projectSelectionNeedingRefresh,
  type ActiveProjectScope,
} from "./active-project";

const storedScope: ActiveProjectScope = {
  projectId: "project-a",
  azureProjectId: "project-a",
  azureProjectName: "Project A",
  azureOrganizationUrl: "https://dev.azure.com/example",
  workspaceId: "ws-current",
};

describe("active project scope reconciliation", () => {
  it("keeps a saved scope when it matches the live project and workspace", () => {
    const project = {
      id: "project-a",
      name: "Project A",
      azureOrganizationUrl: "https://dev.azure.com/example",
      workspaceId: "ws-current",
    };

    expect(projectMatchesActiveScope(storedScope, project)).toBe(true);
    expect(projectSelectionNeedingRefresh(storedScope, [project])).toBeNull();
  });

  it("refreshes a saved scope whose workspaceId is stale", () => {
    const project = {
      id: "project-a",
      name: "Project A",
      azureOrganizationUrl: "https://dev.azure.com/example",
      workspaceId: "ws-current",
    };
    const staleScope = { ...storedScope, workspaceId: "ws-deleted" };

    expect(projectMatchesActiveScope(staleScope, project)).toBe(false);
    expect(projectSelectionNeedingRefresh(staleScope, [project])).toEqual(project);
  });

  it("selects the first live project when no saved scope exists", () => {
    const project = {
      id: "project-a",
      name: "Project A",
      azureOrganizationUrl: "https://dev.azure.com/example",
    };

    expect(projectSelectionNeedingRefresh(null, [project], "ws-current")).toEqual({
      ...project,
      workspaceId: "ws-current",
    });
  });

  it("moves away from a saved project that is no longer in the live list", () => {
    const project = {
      id: "project-b",
      name: "Project B",
      azureOrganizationUrl: "https://dev.azure.com/example",
      workspaceId: "ws-current",
    };

    expect(projectSelectionNeedingRefresh(storedScope, [project])).toEqual(project);
  });
});

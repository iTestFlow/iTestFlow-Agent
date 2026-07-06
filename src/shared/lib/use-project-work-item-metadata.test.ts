import { describe, expect, it } from "vitest";

import {
  projectScopeKey,
  retainAvailableSelections,
  selectAvailableDefaults,
} from "@/shared/lib/use-project-work-item-metadata";
import { projectScope } from "@/test/factories";

describe("projectScopeKey", () => {
  it("returns null when no scope is active", () => {
    expect(projectScopeKey(null)).toBeNull();
  });

  it("normalizes the organization URL by trimming and lowercasing", () => {
    const scope = projectScope({
      azureOrganizationUrl: "  HTTPS://Dev.Azure.com/Demo  ",
      azureProjectId: "azure-project-1",
    });

    expect(projectScopeKey(scope)).toBe("https://dev.azure.com/demo::azure-project-1");
  });

  it("produces one cache key per org/project pair regardless of URL casing", () => {
    const scope = projectScope({ azureOrganizationUrl: "https://dev.azure.com/demo" });
    const recasedScope = projectScope({ azureOrganizationUrl: "https://DEV.azure.com/demo " });

    expect(projectScopeKey(recasedScope)).toBe(projectScopeKey(scope));
  });

  it("keys by project id so sibling projects in the same org do not collide", () => {
    const scope = projectScope({ azureProjectId: "azure-project-1" });
    const siblingScope = projectScope({ azureProjectId: "azure-project-2" });

    expect(projectScopeKey(siblingScope)).not.toBe(projectScopeKey(scope));
  });
});

describe("selectAvailableDefaults", () => {
  it("matches case- and whitespace-insensitively and returns the option's canonical casing", () => {
    const options = ["Bug", "User Story", "Task"];

    expect(selectAvailableDefaults(["  bug ", "USER STORY"], options)).toEqual([
      "Bug",
      "User Story",
    ]);
  });

  it("drops defaults with no matching option in the new project", () => {
    expect(selectAvailableDefaults(["Bug", "Epic"], ["Bug", "Task"])).toEqual(["Bug"]);
  });

  it("returns nothing when the project exposes no options", () => {
    expect(selectAvailableDefaults(["Bug", "Task"], [])).toEqual([]);
  });

  it("returns nothing when there are no defaults", () => {
    expect(selectAvailableDefaults([], ["Bug", "Task"])).toEqual([]);
  });
});

describe("retainAvailableSelections", () => {
  it("keeps selections that still exist, re-emitting the option's canonical casing", () => {
    const options = ["Active", "Closed", "New"];

    expect(retainAvailableSelections(["active", " CLOSED "], options)).toEqual([
      "Active",
      "Closed",
    ]);
  });

  it("drops selections unavailable after a project switch, preserving selection order", () => {
    const options = ["New", "Resolved"];

    expect(retainAvailableSelections(["Resolved", "Removed", "New"], options)).toEqual([
      "Resolved",
      "New",
    ]);
  });

  it("returns nothing when the project exposes no options", () => {
    expect(retainAvailableSelections(["Active"], [])).toEqual([]);
  });

  it("returns nothing when nothing was selected", () => {
    expect(retainAvailableSelections([], ["Active"])).toEqual([]);
  });
});

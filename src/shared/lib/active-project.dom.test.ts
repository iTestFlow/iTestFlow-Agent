// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeProjectStorageKey,
  readActiveProject,
  writeActiveProject,
} from "./active-project";

describe("active project browser persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns null for missing or malformed storage", () => {
    expect(readActiveProject()).toBeNull();
    window.localStorage.setItem(activeProjectStorageKey, "{broken");
    expect(readActiveProject()).toBeNull();
  });

  it("round-trips scope and dispatches the change event", () => {
    const listener = vi.fn();
    window.addEventListener("itestflow:active-project-changed", listener);
    const scope = {
      projectId: "p",
      azureProjectId: "p",
      azureProjectName: "Project",
      azureOrganizationUrl: "https://dev.azure.com/demo",
      workspaceId: "ws",
    };
    writeActiveProject(scope);
    expect(readActiveProject()).toEqual(scope);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("itestflow:active-project-changed", listener);
  });
});

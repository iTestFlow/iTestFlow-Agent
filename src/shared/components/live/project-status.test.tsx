// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeaderProjectSelector } from "./project-status";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/navigation/unsaved-changes-provider", () => ({ useUnsavedChangesGuard: () => ({ confirmAction: (action: () => void) => action() }) }));

describe("HeaderProjectSelector provider labels", () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key), clear: () => values.clear(),
    } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("labels a Jira site and retains provider project identity", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        mode: "live", providerId: "jira-cloud", providerSiteName: "Quality Jira", organizationUrl: "https://quality.atlassian.net", workspaceId: "ws-1",
        projects: [{ id: "10000", key: "QA", name: "Quality", providerProjectId: "10000", providerProjectKey: "QA", azureOrganizationUrl: "https://quality.atlassian.net", workspaceId: "ws-1" }],
      }))
      .mockResolvedValueOnce(json({ scope: { projectId: "project-1", azureProjectId: "10000", azureProjectName: "Quality", azureOrganizationUrl: "https://quality.atlassian.net", providerProjectId: "10000", providerProjectKey: "QA", providerProjectName: "Quality", workspaceId: "ws-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<HeaderProjectSelector />);
    expect(await screen.findByText("Site: Quality Jira")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Project: Quality" })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("itestflow.activeProject") ?? "{}")).toMatchObject({ providerProjectId: "10000", providerProjectKey: "QA" });
  });
});

function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }); }

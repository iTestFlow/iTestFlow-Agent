// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsSection } from "./connections-section";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const jiraOverview = {
  providerId: "jira-cloud", role: "owner",
  workspace: { id: "ws-1", name: "Quality Cloud", siteName: "Quality Jira", siteUrl: "https://quality.atlassian.net" },
  connection: { status: "active" },
  availableProjects: [{ id: "10000", key: "QA", name: "Quality" }],
  projects: [{
    id: "project-1", providerProjectId: "10000", key: "QA", name: "Quality",
    backend: { type: "plain_jira", status: "active", region: null },
    sync: { direction: "two_way", fieldMappings: [{ localField: "title", jiraField: "summary" }], statusMappings: [{ localStatus: "approved", jiraStatus: "Done" }] },
  }],
  mappings: [{ id: "mapping-1", projectId: "project-1", jiraIssueKey: "QA-7", localEntityType: "requirement", localEntityId: "req-1", direction: "two_way", status: "conflict", lastSyncedAt: null, updatedAt: "2026-08-13T09:00:00.000Z" }],
  conflicts: [{ mappingId: "mapping-1", projectId: "project-1", field: "summary", localValue: "Local title", remoteValue: "Remote title", updatedAt: "2026-08-13T09:00:00.000Z" }],
  traceLinks: [{ id: "link-1", projectId: "project-1", localArtifactType: "test_case", localArtifactId: "case-1", remoteArtifactId: "QA-T1", remoteUrl: "https://quality.atlassian.net/browse/QA-T1", backendType: "plain_jira", status: "active", updatedAt: "2026-08-13T09:00:00.000Z" }],
};

describe("ConnectionsSection provider flow", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/session") return json({ authenticated: true, membership: { workspaceId: "ws-1", role: "owner" }, workspace: { id: "ws-1", providerId: "jira-cloud" } });
      if (url === "/api/integrations/jira" && (!init?.method || init.method === "GET")) return json(jiraOverview);
      if (url === "/api/integrations/jira") return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders the connected Jira site, mapping status, conflict choices, and trace link by accessible name", async () => {
    render(<ConnectionsSection />);
    expect(await screen.findByRole("heading", { name: "Jira Cloud Connection" })).toBeInTheDocument();
    expect(screen.getByText("Quality Jira")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open QA-T1 in Jira/ })).toHaveAttribute("href", "https://quality.atlassian.net/browse/QA-T1");
    expect(screen.getByRole("button", { name: "Use iTestFlow value for summary" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Use Jira value for summary" })).toBeEnabled();
  });

  it("selects a trusted project and resolves a conflict through keyboard-operable controls", async () => {
    const user = userEvent.setup();
    render(<ConnectionsSection />);
    await screen.findByRole("heading", { name: "Jira Cloud Connection" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Available Jira project" }), "10000");
    await user.click(screen.getByRole("button", { name: "Add Jira project" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/integrations/jira", expect.objectContaining({ method: "POST" })));
    const projectRequest = fetchMock.mock.calls.find(([, init]) => JSON.parse(String(init?.body ?? "{}"))?.action === "select_project");
    expect(JSON.parse(String(projectRequest?.[1]?.body))).toEqual({ action: "select_project", providerProjectId: "10000" });

    await user.click(screen.getByRole("button", { name: "Use Jira value for summary" }));
    const conflictRequest = fetchMock.mock.calls.find(([, init]) => JSON.parse(String(init?.body ?? "{}"))?.action === "resolve_conflict");
    expect(JSON.parse(String(conflictRequest?.[1]?.body))).toMatchObject({ mappingId: "mapping-1", field: "summary", resolution: "use_remote" });
  });

  it("does not expose shared project onboarding to a workspace member", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/session") return json({ authenticated: true, workspace: { id: "ws-1", providerId: "jira-cloud" } });
      if (url === "/api/integrations/jira") return json({ ...jiraOverview, role: "member" });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<ConnectionsSection />);
    await screen.findByRole("heading", { name: "Jira Cloud Connection" });
    expect(screen.queryByRole("button", { name: "Add Jira project" })).not.toBeInTheDocument();
  });

  it("requires an explicit second action before disconnecting the current Jira account", async () => {
    const user = userEvent.setup();
    render(<ConnectionsSection />);
    await screen.findByRole("heading", { name: "Jira Cloud Connection" });
    await user.click(screen.getByRole("button", { name: "Disconnect Jira Cloud" }));
    expect(screen.getByRole("button", { name: "Confirm Jira Cloud disconnect" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm Jira Cloud disconnect" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
  });

  it("saves the rendered field and status mapping contract", async () => {
    const user = userEvent.setup();
    render(<ConnectionsSection />);
    await screen.findByRole("heading", { name: "Jira Cloud Connection" });
    await user.click(screen.getByRole("button", { name: "Save synchronization mapping" }));
    const mappingRequest = await waitFor(() => {
      const call = actionCall(fetchMock, "configure_sync");
      expect(call).toBeDefined();
      return call;
    });
    expect(JSON.parse(String(mappingRequest?.[1]?.body))).toMatchObject({
      projectId: "project-1", direction: "two_way",
      fieldMappings: [{ localField: "title", jiraField: "summary" }],
      statusMappings: [{ localStatus: "approved", jiraStatus: "Done" }],
    });
  });

  it.each([
    ["Plain Jira", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.type(screen.getByLabelText("Jira Test Case issue type ID"), "10001");
      await user.type(screen.getByLabelText("Immutable local ID custom field"), "customfield_10002");
    }, { backendType: "plain_jira", testCaseIssueTypeId: "10001", localIdFieldId: "customfield_10002" }],
    ["Xray Cloud", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.type(screen.getByLabelText("Xray client ID"), "client-1");
      await user.type(screen.getByLabelText("Xray client secret"), "secret-1");
      await user.type(screen.getByLabelText("Immutable local ID custom field"), "customfield_10003");
    }, { backendType: "xray_cloud", clientId: "client-1", clientSecret: "secret-1", localIdFieldId: "customfield_10003" }],
    ["Zephyr Scale Cloud", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.type(screen.getByLabelText("Zephyr Scale API token"), "token-1");
      await user.selectOptions(screen.getByLabelText("Zephyr Scale region"), "eu");
      await user.type(screen.getByLabelText("Immutable local ID field name"), "iTestFlow ID");
    }, { backendType: "zephyr_scale", apiToken: "token-1", region: "eu", localIdFieldName: "iTestFlow ID" }],
  ])("configures %s through the same project-owned form", async (backendLabel, fill, expected) => {
    const user = userEvent.setup();
    render(<ConnectionsSection />);
    await screen.findByRole("heading", { name: "Jira Cloud Connection" });
    await user.selectOptions(screen.getByLabelText("Artifact backend"), String(backendLabel === "Plain Jira" ? "plain_jira" : backendLabel === "Xray Cloud" ? "xray_cloud" : "zephyr_scale"));
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save artifact backend" }));
    const backendRequest = await waitFor(() => {
      const call = actionCall(fetchMock, "configure_backend");
      expect(call).toBeDefined();
      return call;
    });
    expect(JSON.parse(String(backendRequest?.[1]?.body))).toMatchObject({ projectId: "project-1", ...expected });
  });

  it("preserves the existing Azure DevOps PAT settings for Azure workspaces", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/session") return json({ authenticated: true, workspace: { id: "azure-ws", providerId: "azure-devops" } });
      if (url === "/api/settings/credentials") return json({ workspaceId: "azure-ws", azureOrgUrl: "https://dev.azure.com/contoso", azurePat: { status: "configured", maskedPreview: "***" }, llm: { status: "not_configured", maskedPreview: null } });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<ConnectionsSection />);
    expect(await screen.findByRole("heading", { name: "Azure DevOps Connection" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("https://dev.azure.com/contoso")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Jira Cloud Connection" })).not.toBeInTheDocument();
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function actionCall(mock: ReturnType<typeof vi.fn>, action: string) {
  return mock.mock.calls.find(([, init]) => {
    try { return JSON.parse(String(init?.body ?? "{}"))?.action === action; } catch { return false; }
  });
}

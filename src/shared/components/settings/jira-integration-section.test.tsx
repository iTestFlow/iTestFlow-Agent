// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraIntegrationSection } from "./jira-integration-section";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function overview(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "jira-cloud", role: "owner",
    workspace: { id: "ws-1", name: "Quality Cloud", siteName: "Quality Jira", siteUrl: "https://quality.atlassian.net" },
    connection: { status: "active" },
    availableProjects: [],
    projects: [],
    mappings: [],
    conflicts: [],
    traceLinks: [],
    ...overrides,
  };
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("JiraIntegrationSection", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reconnects through the workspace's own site so OAuth cannot silently land elsewhere", async () => {
    fetchMock.mockResolvedValue(json(overview({ connection: { status: "reauthorization_required" } })));

    render(<JiraIntegrationSection />);

    const link = await screen.findByRole("link", { name: "Reconnect Jira Cloud" });
    expect(link).toHaveAttribute(
      "href",
      `/api/auth/jira/start?returnTo=%2Fsettings&site=${encodeURIComponent("https://quality.atlassian.net")}`,
    );
  });

  it("does not offer reconnect while the connection is active", async () => {
    fetchMock.mockResolvedValue(json(overview()));

    render(<JiraIntegrationSection />);

    await screen.findByText("Quality Jira");
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Reconnect Jira Cloud" })).toBeNull();
    });
  });

  it("requires an explicit backend choice for an unconfigured project — Plain Jira is never a silent default", async () => {
    fetchMock.mockResolvedValue(json(overview({
      projects: [{
        id: "project-1", providerProjectId: "10000", key: "QA", name: "Quality",
        backend: null,
        sync: null,
      }],
    })));

    render(<JiraIntegrationSection />);

    const backendSelect = await screen.findByLabelText("Artifact backend");
    expect(backendSelect).toHaveValue("");
    expect(screen.getByRole("option", { name: "Select a backend" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save artifact backend" })).toBeDisabled();

    fireEvent.change(backendSelect, { target: { value: "xray_cloud" } });
    expect(screen.getByRole("button", { name: "Save artifact backend" })).toBeEnabled();
  });

  it("keeps the configured backend pre-selected with Save enabled", async () => {
    fetchMock.mockResolvedValue(json(overview({
      projects: [{
        id: "project-1", providerProjectId: "10000", key: "QA", name: "Quality",
        backend: { type: "zephyr_scale", status: "active", region: "eu" },
        sync: null,
      }],
    })));

    render(<JiraIntegrationSection />);

    expect(await screen.findByLabelText("Artifact backend")).toHaveValue("zephyr_scale");
    expect(screen.getByRole("button", { name: "Save artifact backend" })).toBeEnabled();
  });
});

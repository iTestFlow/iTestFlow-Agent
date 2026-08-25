// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});

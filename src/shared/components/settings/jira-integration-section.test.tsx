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
    syncPrincipal: { exists: true, status: "active", userId: "sync-user", isActor: false },
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

  it("opens the token form for an invalid connection and replaces it through the connect action", async () => {
    fetchMock.mockResolvedValue(json(overview({ connection: { status: "invalid" } })));

    render(<JiraIntegrationSection />);

    // Tri-state badge: invalid is destructive and actionable, not a vague warning.
    expect(await screen.findByText("Invalid token")).toBeInTheDocument();
    const email = await screen.findByLabelText("Atlassian account email");
    const token = screen.getByLabelText("Atlassian API token");
    expect(token).toHaveAttribute("type", "password");

    fireEvent.change(email, { target: { value: "owner@example.test" } });
    fireEvent.change(token, { target: { value: "replacement-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      const connectCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String((connectCall![1] as RequestInit).body))).toEqual({
        action: "connect", emailAddress: "owner@example.test", apiToken: "replacement-token",
      });
    });
  });

  it("keeps the token form behind a Replace affordance while the connection is active", async () => {
    fetchMock.mockResolvedValue(json(overview()));

    render(<JiraIntegrationSection />);

    await screen.findByText("Quality Jira");
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Atlassian API token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replace API token" }));
    expect(screen.getByLabelText("Atlassian API token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep saved token" })).toBeInTheDocument();
  });

  it("renders a failed connect inline with the API message, retry hint, and the typed token kept", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") {
        return {
          ok: false, status: 429,
          headers: new Headers({ "Retry-After": "45" }),
          json: async () => ({ error: "Too many connection attempts." }),
        } as Response;
      }
      return json(overview({ connection: { status: "revoked" } }));
    });

    render(<JiraIntegrationSection />);

    fireEvent.change(await screen.findByLabelText("Atlassian account email"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("Atlassian API token"), { target: { value: "new-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Jira connection could not be stored.");
    expect(alert).toHaveTextContent("Too many connection attempts. Retry in 45s.");
    // The typed token survives the failure for correction — only success clears it.
    expect(screen.getByLabelText("Atlassian API token")).toHaveValue("new-token");
  });

  it("raises an actionable alert when the workspace sync owner's token is invalid", async () => {
    fetchMock.mockResolvedValue(json(overview({
      syncPrincipal: { exists: true, status: "invalid", userId: "sync-user", isActor: false },
    })));

    render(<JiraIntegrationSection />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Scheduled Jira sync is blocked.");
    expect(alert).toHaveTextContent("owner or admin must replace their Jira API token");
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

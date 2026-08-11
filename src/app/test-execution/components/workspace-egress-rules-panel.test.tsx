// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceEgressRulesPanel } from "./workspace-egress-rules-panel";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Payments",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

const apiRule = {
  id: "tegr-api-1",
  name: "Staging orders API",
  targetKind: "api" as const,
  protocol: "https" as const,
  hostPattern: "api.staging.example.com",
  portFrom: 443,
  portTo: 443,
  allowPrivateNetwork: false,
  enabled: true,
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    scrollIntoView: { configurable: true, value: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspaceEgressRulesPanel", () => {
  it("explains default-deny behavior to members without calling the admin-only route", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceEgressRulesPanel scope={scope} workspaceRole="member" />);

    expect(screen.getByText("Outbound connections are default-deny")).toBeInTheDocument();
    expect(screen.getByText(/Ask a workspace owner or admin/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads workspace rules and sends a minimal PATCH when an admin disables one", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return jsonResponse({ rules: [apiRule] });
      if (init.method === "PATCH") return jsonResponse({ rule: { ...apiRule, enabled: false } });
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<WorkspaceEgressRulesPanel scope={scope} workspaceRole="admin" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/test-execution/egress-rules?workspaceId=workspace-1",
    );
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByText("Staging orders API")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Enabled" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toBe("/api/test-execution/egress-rules/tegr-api-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: "workspace-1",
      changes: { enabled: false },
    });
    expect(await screen.findByRole("switch", { name: "Disabled" })).not.toBeChecked();
  });

  it("validates a new rule and sends the complete POST contract", async () => {
    const createdRule = {
      ...apiRule,
      id: "tegr-public-api-1",
      name: "Public API target",
      targetKind: "api" as const,
      hostPattern: "api.example.com",
      portFrom: 443,
      portTo: 443,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return jsonResponse({ rules: [] });
      if (init.method === "POST") return jsonResponse({ rule: createdRule }, 201);
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<WorkspaceEgressRulesPanel scope={scope} workspaceRole="owner" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: "New rule" }));
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Public API target" } });
    fireEvent.change(screen.getByLabelText("Host pattern"), { target: { value: "api.example.com" } });

    fireEvent.change(screen.getByLabelText("Port from"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Port to"), { target: { value: "400" } });
    await user.click(screen.getByRole("button", { name: "Create rule" }));

    expect(await screen.findByText("Port to must be greater than or equal to port from.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Port from"), { target: { value: "443" } });
    fireEvent.change(screen.getByLabelText("Port to"), { target: { value: "443" } });
    await user.click(screen.getByRole("button", { name: "Create rule" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toBe("/api/test-execution/egress-rules");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: "workspace-1",
      rule: {
        name: "Public API target",
        targetKind: "api",
        protocol: "https",
        hostPattern: "api.example.com",
        portFrom: 443,
        portTo: 443,
        allowPrivateNetwork: false,
        enabled: true,
      },
    });
    expect(await screen.findByText("Public API target")).toBeInTheDocument();
  });

  it("requires confirmation and sends the workspace-scoped DELETE contract", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return jsonResponse({ rules: [apiRule] });
      if (init.method === "DELETE") return jsonResponse({ deleted: true });
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<WorkspaceEgressRulesPanel scope={scope} workspaceRole="owner" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: "Delete Staging orders API" }));
    expect(screen.getByRole("alertdialog", { name: "Delete network access rule?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete rule" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toBe("/api/test-execution/egress-rules/tegr-api-1");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: "workspace-1" });
    await waitFor(() => expect(screen.queryByText("Staging orders API")).not.toBeInTheDocument());
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationCapabilitiesPanel } from "./integration-capabilities-panel";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Payments",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

const approvedApiOperation = {
  id: "tiop-approved-1",
  stableKey: "orders.create",
  displayName: "Create order",
  revision: 2,
  layer: "api",
  sourceKind: "manual",
  safetyClass: "mutation",
  databaseDriver: null,
  apiContractRevisionId: null,
  parameterSchema: { type: "object" },
  definition: { method: "POST", path: "/orders" },
  approvalStatus: "approved",
  approvedAt: "2026-08-10T10:00:00.000Z",
  createdAt: "2026-08-10T10:00:00.000Z",
};

const apiEnvironment = {
  targets: ["API"] as const,
  databaseDriver: null,
  apiMutationsEnabled: true,
  databaseDmlEnabled: false,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => cleanup());

describe("IntegrationCapabilitiesPanel", () => {
  it("lets members select only compatible approved revisions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return jsonResponse({ operations: [approvedApiOperation] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSelectedIdsChange = vi.fn();
    const user = userEvent.setup();

    render(
      <IntegrationCapabilitiesPanel
        scope={scope}
        workspaceRole="member"
        environment={apiEnvironment}
        selectedIds={[]}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("includeAll=false");
    await user.click(screen.getByRole("button", { name: "Choose" }));
    expect(await screen.findByText("Create order")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new capability/i })).not.toBeInTheDocument();

    onSelectedIdsChange.mockClear();
    await user.click(screen.getByRole("checkbox", { name: /Create order/i }));
    expect(onSelectedIdsChange).toHaveBeenCalledWith(["tiop-approved-1"]);
  });

  it("shows owners an accessible manual editor with parameterized safe templates", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return jsonResponse({ operations: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <IntegrationCapabilitiesPanel
        scope={scope}
        workspaceRole="owner"
        environment={apiEnvironment}
        selectedIds={[]}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("includeAll=true"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("includeAll=false"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: /new capability/i }));

    expect(screen.getByRole("dialog", { name: "New integration capability" })).toBeInTheDocument();
    expect((screen.getByLabelText("Parameter schema (JSON object)") as HTMLTextAreaElement).value)
      .toContain("additionalProperties");
    expect((screen.getByLabelText("Executor definition (JSON object)") as HTMLTextAreaElement).value)
      .toContain("{orderId}");
    expect(screen.queryByRole("button", { name: /test connection/i })).not.toBeInTheDocument();
  });
});

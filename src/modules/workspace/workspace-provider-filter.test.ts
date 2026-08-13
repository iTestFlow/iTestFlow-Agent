import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlAll: vi.fn().mockResolvedValue([]) }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-08-13T00:00:00.000Z", sqlAll: mocks.sqlAll, sqlGet: vi.fn(),
}));
vi.mock("./workspace-access.service", () => ({ getWorkspaceMembership: vi.fn() }));

import { listActiveWorkspaces } from "./workspace.service";

it("keeps Jira workspaces out of the legacy Azure pre-auth organization picker", async () => {
  await listActiveWorkspaces();
  expect(mocks.sqlAll.mock.calls[0][0]).toContain("provider_id = 'azure-devops'");
});

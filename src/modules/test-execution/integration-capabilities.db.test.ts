import { afterAll, beforeAll, expect, it } from "vitest";

import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";
import {
  createIntegrationOperation,
  IntegrationOperationError,
  listIntegrationOperations,
  transitionIntegrationOperation,
} from "./integration-capabilities.service";

const workspaceId = uniqueTestId("ws_iop");
const projectId = uniqueTestId("proj_iop");
const userId = uniqueTestId("usr_iop");
const orgUrl = `https://dev.azure.com/${workspaceId}`;
const scope = {
  projectId,
  azureProjectId: projectId,
  azureProjectName: projectId,
  azureOrganizationUrl: orgUrl,
};

describeDb("integration capability revisions", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    // Immutable revisions are removed only by the project-scope cascade.
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("keeps approved revisions active while a successor draft is reviewed, then archives the operation", async () => {
    const draft = await createIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operation: {
        stableKey: `api.get_customer.${uniqueTestId("key").toLowerCase()}`,
        displayName: "Get customer",
        layer: "api",
        sourceKind: "manual",
        safetyClass: "read",
        databaseDriver: null,
        apiContractRevisionId: null,
        parameterSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        definition: { method: "GET", path: "/customers/{id}" },
      },
    });
    expect(draft).toMatchObject({ revision: 1, approvalStatus: "draft" });
    expect(await listIntegrationOperations({ workspaceId, scope })).toEqual([]);
    expect(await listIntegrationOperations({ workspaceId, scope, includeAll: true })).toEqual([
      expect.objectContaining({ id: draft.id, approvalStatus: "draft" }),
    ]);

    const approved = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: draft.id,
      action: "approve",
    });
    expect(approved).toMatchObject({ revision: 2, approvalStatus: "approved" });
    expect(await listIntegrationOperations({ workspaceId, scope })).toEqual([
      expect.objectContaining({ id: approved?.id, revision: 2 }),
    ]);

    const successorDraft = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: approved!.id,
      action: "revise",
      changes: { displayName: "Get one customer" },
    });
    expect(successorDraft).toMatchObject({ revision: 3, approvalStatus: "draft" });
    expect(await listIntegrationOperations({ workspaceId, scope })).toEqual([
      expect.objectContaining({ id: approved?.id, displayName: "Get customer" }),
    ]);
    expect(await listIntegrationOperations({ workspaceId, scope, includeAll: true })).toEqual([
      expect.objectContaining({ id: successorDraft?.id, displayName: "Get one customer" }),
    ]);

    const archived = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: successorDraft!.id,
      action: "archive",
    });
    expect(archived).toMatchObject({ revision: 4, approvalStatus: "archived" });
    expect(await listIntegrationOperations({ workspaceId, scope })).toEqual([]);

    const replacementDraft = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: archived!.id,
      action: "revise",
      changes: { displayName: "Get customer v2" },
    });
    expect(replacementDraft).toMatchObject({ revision: 5, approvalStatus: "draft" });
    expect(await listIntegrationOperations({ workspaceId, scope })).toEqual([]);

    const replacementApproval = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: replacementDraft!.id,
      action: "approve",
    });
    expect(replacementApproval).toMatchObject({ revision: 6, approvalStatus: "approved" });
    expect(await listIntegrationOperations({ workspaceId, scope })).toEqual([
      expect.objectContaining({ id: replacementApproval?.id, displayName: "Get customer v2" }),
    ]);
  });

  it("rejects duplicate identities, stale transitions, and unsafe definitions", async () => {
    const stableKey = `db.lookup.${uniqueTestId("key").toLowerCase()}`;
    const draft = await createIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operation: {
        stableKey,
        displayName: "Lookup order",
        layer: "db",
        sourceKind: "manual",
        safetyClass: "read",
        databaseDriver: "postgres",
        apiContractRevisionId: null,
        parameterSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        definition: { sql: "SELECT id FROM public.orders WHERE id = :id" },
      },
    });
    await expect(
      createIntegrationOperation({
        workspaceId,
        scope,
        actor: userId,
        operation: {
          stableKey,
          displayName: "Duplicate",
          layer: "db",
          sourceKind: "manual",
          safetyClass: "read",
          databaseDriver: "postgres",
          apiContractRevisionId: null,
          parameterSchema: {},
          definition: { sql: "SELECT 1" },
        },
      }),
    ).rejects.toMatchObject({ status: 409 });

    const approved = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: draft.id,
      action: "approve",
    });
    await expect(
      transitionIntegrationOperation({
        workspaceId,
        scope,
        actor: userId,
        operationRevisionId: draft.id,
        action: "approve",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(approved).toBeTruthy();

    await expect(
      createIntegrationOperation({
        workspaceId,
        scope,
        actor: userId,
        operation: {
          stableKey: `db.drop.${uniqueTestId("key").toLowerCase()}`,
          displayName: "Unsafe",
          layer: "db",
          sourceKind: "manual",
          safetyClass: "mutation",
          databaseDriver: "postgres",
          apiContractRevisionId: null,
          parameterSchema: {},
          definition: { sql: "DROP TABLE customers" },
        },
      }),
    ).rejects.toBeInstanceOf(IntegrationOperationError);

    await expect(
      createIntegrationOperation({
        workspaceId,
        scope,
        actor: userId,
        operation: {
          stableKey: `api.unsafe-path.${uniqueTestId("key").toLowerCase()}`,
          displayName: "Unsafe path",
          layer: "api",
          sourceKind: "manual",
          safetyClass: "read",
          databaseDriver: null,
          apiContractRevisionId: null,
          parameterSchema: {},
          definition: { method: "GET", path: "/orders?redirect=/admin" },
        },
      }),
    ).rejects.toBeInstanceOf(IntegrationOperationError);
  });
});

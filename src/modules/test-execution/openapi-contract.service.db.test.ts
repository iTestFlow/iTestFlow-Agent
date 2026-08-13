import { afterAll, beforeAll, expect, it } from "vitest";

import { sqlAll } from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

import { setTestExecutionEgressResolverForTests } from "./egress-policy.service";
import { deriveExecutionBoundary } from "./execution-boundary";
import {
  freezeSameOriginOpenApiContract,
  setOpenApiContractFetchForTests,
} from "./openapi-contract.service";

const workspaceId = uniqueTestId("ws_oapi");
const projectId = uniqueTestId("proj_oapi");
const userId = uniqueTestId("usr_oapi");
const orgUrl = `https://dev.azure.com/${workspaceId}`;
const sourceUrl = "https://api.example.test/openapi.json";
const boundary = deriveExecutionBoundary({ api: { baseUrl: "https://api.example.test/v1" } });
const scope = {
  projectId,
  azureProjectId: projectId,
  azureProjectName: projectId,
  azureOrganizationUrl: orgUrl,
};

describeDb("same-origin OpenAPI contract freezing", () => {
  let currentDocument: Record<string, unknown>;

  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.test` });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
    setTestExecutionEgressResolverForTests(async () => ["203.0.113.42"]);
    currentDocument = {
      openapi: "3.0.3",
      components: { securitySchemes: { bearer: { secret: "must-not-persist" } } },
      paths: { "/orders/{id}": { get: { operationId: "getOrder" } } },
    };
    setOpenApiContractFetchForTests(async () => new Response(JSON.stringify(currentDocument), {
      headers: { "content-type": "application/json" },
    }));
  });

  afterAll(async () => {
    setOpenApiContractFetchForTests(null);
    setTestExecutionEgressResolverForTests(null);
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("reuses identical normalized content and creates a successor when operations change", async () => {
    const first = await freezeSameOriginOpenApiContract({
      workspaceId,
      scope,
      actor: userId,
      boundary,
      baseUrl: "https://api.example.test/v1",
      sourceUrl,
    });
    currentDocument = {
      openapi: "3.0.3",
      info: { title: "Ignored raw metadata changed" },
      components: { securitySchemes: { bearer: { secret: "different-raw-secret" } } },
      paths: { "/orders/{id}": { get: { operationId: "getOrder" } } },
    };
    const reused = await freezeSameOriginOpenApiContract({
      workspaceId,
      scope,
      actor: userId,
      boundary,
      baseUrl: "https://api.example.test/v1",
      sourceUrl,
    });
    expect(reused).toMatchObject({ revisionId: first.revisionId, revision: 1, reused: true });

    currentDocument = {
      openapi: "3.0.3",
      paths: {
        "/orders/{id}": {
          get: { operationId: "getOrder" },
          head: { operationId: "headOrder" },
        },
      },
    };
    const successor = await freezeSameOriginOpenApiContract({
      workspaceId,
      scope,
      actor: userId,
      boundary,
      baseUrl: "https://api.example.test/v1",
      sourceUrl,
    });
    expect(successor).toMatchObject({ revision: 2, operationCount: 2, reused: false });
    expect(successor.revisionId).not.toBe(first.revisionId);

    const rows = await sqlAll<{
      revision: number;
      source_url: string;
      normalized_spec_json: Record<string, unknown>;
      operation_count: number;
    }>(
      `SELECT revision, source_url, normalized_spec_json, operation_count
       FROM test_api_contract_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
       ORDER BY revision`,
      { workspaceId, projectId },
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.operation_count)).toEqual([1, 2]);
    expect(rows[0].source_url).toBe(sourceUrl);
    expect(JSON.stringify(rows[0].normalized_spec_json)).not.toContain("must-not-persist");
  });
});

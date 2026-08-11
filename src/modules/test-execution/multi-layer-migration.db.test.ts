import { afterAll, beforeAll, expect, it } from "vitest";
import { createRequire } from "node:module";

import {
  nowIso,
  sqlRun,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

import { createEnvironmentProfile } from "./environment-profile.service";
import { EnvironmentConfigInputSchema } from "./schemas/test-execution.schemas";

type SqlMigration = {
  down: (pgm: { sql: (statement: string) => void }) => void;
};

const loadMigration = createRequire(import.meta.url);
const migration = loadMigration(
  "../../../migrations/1710000043000_test_execution_multi_layer_foundation.js",
) as SqlMigration;
let downSql = "";
migration.down({
  sql(statement) {
    downSql += statement;
  },
});

const workspaceId = uniqueTestId("ws_multidown");
const projectId = uniqueTestId("proj_multidown");
const userId = uniqueTestId("usr_multidown");
const orgUrl = `https://dev.azure.com/${workspaceId}`;
const scope = {
  projectId,
  azureProjectId: projectId,
  azureProjectName: projectId,
  azureOrganizationUrl: orgUrl,
};

async function expectDownRefused(message: RegExp): Promise<void> {
  // Always throw if the migration unexpectedly reaches the end so the schema
  // changes are rolled back instead of damaging the integration-test database.
  await expect(
    withTransaction(async (client) => {
      await sqlRun(downSql, {}, client);
      throw new Error("Multi-layer rollback unexpectedly succeeded.");
    }),
  ).rejects.toThrow(message);
}

describeDb("multi-layer migration rollback safety", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM test_environment_profiles WHERE workspace_id = @workspaceId`, {
      workspaceId,
    });
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("refuses to rewrite an API-only profile into a fabricated UI target", async () => {
    const profileId = uniqueTestId("tenv_api_only");
    await sqlRun(
      `INSERT INTO test_environment_profiles (
         id, workspace_id, project_id, azure_project_id, name,
         api_config_json, created_by, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, @name,
         '{"baseUrl":"https://api.example.com","auth":{"type":"none"}}'::jsonb,
         @userId, @now, @now
       )`,
      {
        id: profileId,
        workspaceId,
        projectId,
        name: uniqueTestId("api_only"),
        userId,
        now: nowIso(),
      },
    );

    await expectDownRefused(/API\/DB-only environment profiles exist/i);
    await sqlRun(`DELETE FROM test_environment_profiles WHERE id = @profileId`, {
      profileId,
    });
  });

  it("refuses to discard scoped API or database connection secrets", async () => {
    const profile = await createEnvironmentProfile({
      workspaceId,
      scope,
      actor: userId,
      config: EnvironmentConfigInputSchema.parse({
        name: uniqueTestId("ui_api_profile"),
        initialUrl: "https://app.example.com/login",
        allowedOrigin: "https://app.example.com",
        api: {
          baseUrl: "https://api.example.com",
          auth: { type: "bearer" },
        },
      }),
      secrets: [
        {
          secretName: "api.bearer_token",
          title: "API bearer token",
          value: "rollback-protected-token",
          purpose: "api_auth",
        },
      ],
    });

    await expectDownRefused(/scoped API\/DB connection secrets exist/i);
    await sqlRun(`DELETE FROM test_environment_profiles WHERE id = @profileId`, {
      profileId: profile.id,
    });
  });
});

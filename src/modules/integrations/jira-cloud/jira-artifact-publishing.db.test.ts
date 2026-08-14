import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedMembership, seedProject, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";
import { JiraArtifactPublishInProgressError, withAuthorizedJiraArtifactConfigurationLock } from "./jira-artifact-project-lock";
import { publishPlainJiraTestCase, storePlainJiraArtifactConfig } from "./jira-artifact-publishing.service";

let workspaceId: string;
let projectId: string;
let ownerId: string;

describeDb("Jira artifact publication/configuration fence (PostgreSQL)", () => {
  beforeEach(async () => {
    workspaceId = uniqueTestId("ws_jira_publish");
    projectId = uniqueTestId("project_jira_publish");
    ownerId = uniqueTestId("owner_jira_publish");
    const siteUrl = `https://${workspaceId}.atlassian.net`;
    await seedWorkspace({ id: workspaceId, orgUrl: siteUrl });
    await seedUser({ id: ownerId, email: `${ownerId}@itestflow.test` });
    await seedMembership({ workspaceId, userId: ownerId, role: "owner" });
    await seedProject({ workspaceId, orgUrl: siteUrl, azureProjectId: projectId, azureProjectName: "Quality" });
    await sqlRun(
      `UPDATE workspaces SET provider_id = 'jira-cloud', provider_site_id = @siteId,
         provider_site_name = 'Quality', provider_site_url = @siteUrl
       WHERE id = @workspaceId`,
      { workspaceId, siteId: uniqueTestId("cloud"), siteUrl },
    );
    await sqlRun(
      `UPDATE projects SET provider_id = 'jira-cloud', provider_project_id = @providerProjectId,
         provider_project_key = 'QA', provider_project_name = 'Quality'
       WHERE workspace_id = @workspaceId AND id = @projectId`,
      { workspaceId, projectId, providerProjectId: uniqueTestId("jira_numeric") },
    );
    await storePlainJiraArtifactConfig({
      workspaceId, projectId, actorUserId: ownerId,
      testCaseIssueTypeId: "10001", localIdFieldId: "customfield_10002",
    });
  });

  afterEach(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [ownerId] });
    await resetDatabaseForTests();
  });

  it("lets a publication claim win and rejects configuration while the live claim exists", async () => {
    const remoteStarted = deferred<void>();
    const releaseRemote = deferred<void>();
    const backend = {
      createTestCase: vi.fn(async () => {
        remoteStarted.resolve();
        await releaseRemote.promise;
        return { success: true, azureTestCaseId: "QA-9" };
      }),
    };
    const publishing = publishPlainJiraTestCase({ ...publishInput("case-claim-wins"), backend });
    await remoteStarted.promise;

    try {
      await expect(storePlainJiraArtifactConfig({
        workspaceId, projectId, actorUserId: ownerId,
        testCaseIssueTypeId: "10002", localIdFieldId: "customfield_10003",
      })).rejects.toBeInstanceOf(JiraArtifactPublishInProgressError);
    } finally {
      releaseRemote.resolve();
    }
    await expect(publishing).resolves.toMatchObject({ remoteId: "QA-9", created: true });
  });

  it("lets a configuration transaction win and makes the waiting old-backend claim revalidate", async () => {
    const switchStarted = deferred<void>();
    const releaseSwitch = deferred<void>();
    const switching = withAuthorizedJiraArtifactConfigurationLock(
      { workspaceId, projectId, actorUserId: ownerId },
      async ({ client, now }) => {
        await sqlRun(
          `UPDATE jira_artifact_backend_configs
           SET backend_type = 'xray_cloud', config_json = '{}', status = 'active', updated_at = @now
           WHERE workspace_id = @workspaceId AND project_id = @projectId`,
          { workspaceId, projectId, now },
          client,
        );
        switchStarted.resolve();
        await releaseSwitch.promise;
      },
    );
    await switchStarted.promise;
    const backend = { createTestCase: vi.fn() };
    const publishing = publishPlainJiraTestCase({ ...publishInput("case-config-wins"), backend });

    try {
      await expect(Promise.race([
        publishing.then(() => "settled", () => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ])).resolves.toBe("blocked");
    } finally {
      releaseSwitch.resolve();
      await switching;
    }

    await expect(publishing).rejects.toThrow("not authorized");
    expect(backend.createTestCase).not.toHaveBeenCalled();
  });

  it("retires a failed claim immediately so configuration repair and retry can proceed", async () => {
    const localId = "case-failed";
    const failedBackend = { createTestCase: vi.fn().mockRejectedValue(new Error("remote failed")) };
    await expect(publishPlainJiraTestCase({ ...publishInput(localId), backend: failedBackend })).rejects.toThrow("remote failed");
    await expect(linkStatus(localId)).resolves.toBe("error");

    await expect(storePlainJiraArtifactConfig({
      workspaceId, projectId, actorUserId: ownerId,
      testCaseIssueTypeId: "10002", localIdFieldId: "customfield_10003",
    })).resolves.toBeUndefined();
    const recoveredBackend = { createTestCase: vi.fn().mockResolvedValue({ success: true, azureTestCaseId: "QA-10" }) };
    await expect(publishPlainJiraTestCase({ ...publishInput(localId), backend: recoveredBackend }))
      .resolves.toMatchObject({ remoteId: "QA-10", created: true });
    await expect(linkStatus(localId)).resolves.toBe("active");
  });

  it("retires an expired claim, permits repair, and rejects the late publisher finalization", async () => {
    const localId = "case-stale";
    const remoteStarted = deferred<void>();
    const releaseRemote = deferred<void>();
    const backend = {
      createTestCase: vi.fn(async () => {
        remoteStarted.resolve();
        await releaseRemote.promise;
        return { success: true, azureTestCaseId: "QA-11" };
      }),
    };
    const publishing = publishPlainJiraTestCase({ ...publishInput(localId), backend });
    await remoteStarted.promise;
    await sqlRun(
      `UPDATE jira_artifact_links SET updated_at = '2000-01-01T00:00:00.000Z'
       WHERE workspace_id = @workspaceId AND project_id = @projectId AND local_artifact_id = @localId`,
      { workspaceId, projectId, localId },
    );

    try {
      await expect(storePlainJiraArtifactConfig({
        workspaceId, projectId, actorUserId: ownerId,
        testCaseIssueTypeId: "10002", localIdFieldId: "customfield_10003",
      })).resolves.toBeUndefined();
      await expect(linkStatus(localId)).resolves.toBe("error");
    } finally {
      releaseRemote.resolve();
    }
    await expect(publishing).rejects.toThrow("not authorized");
    await expect(linkStatus(localId)).resolves.toBe("error");
  });
});

function publishInput(localId: string) {
  return {
    workspaceId,
    projectId,
    actorUserId: ownerId,
    siteUrl: `https://${workspaceId}.atlassian.net`,
    testCase: { localId, targetUserStoryId: "QA-7", title: "Checkout", steps: [] },
  };
}

async function linkStatus(localId: string): Promise<string | undefined> {
  return (await sqlGet<{ status: string }>(
    `SELECT status FROM jira_artifact_links
     WHERE workspace_id = @workspaceId AND project_id = @projectId AND local_artifact_id = @localId`,
    { workspaceId, projectId, localId },
  ))?.status;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

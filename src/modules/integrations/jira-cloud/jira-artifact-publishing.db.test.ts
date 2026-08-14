import { afterEach, beforeEach, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ resolveJiraAccessToken: vi.fn() }));
vi.mock("@/modules/auth/jira-connection.service", () => ({ resolveJiraAccessToken: authMocks.resolveJiraAccessToken }));

import { resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedMembership, seedProject, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";
import { JiraArtifactPublishInProgressError, withAuthorizedJiraArtifactConfigurationLock } from "./jira-artifact-project-lock";
import { publishConfiguredJiraTestCases, publishPlainJiraTestCase, storePlainJiraArtifactConfig } from "./jira-artifact-publishing.service";

let workspaceId: string;
let projectId: string;
let ownerId: string;
let providerProjectId: string;

describeDb("Jira artifact publication/configuration fence (PostgreSQL)", () => {
  beforeEach(async () => {
    workspaceId = uniqueTestId("ws_jira_publish");
    projectId = uniqueTestId("project_jira_publish");
    ownerId = uniqueTestId("owner_jira_publish");
    providerProjectId = uniqueTestId("jira_numeric");
    authMocks.resolveJiraAccessToken.mockResolvedValue("access-token");
    vi.stubEnv("ITESTFLOW_PUBLIC_URL", "https://itestflow.example");
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
      { workspaceId, projectId, providerProjectId },
    );
    await storePlainJiraArtifactConfig({
      workspaceId, projectId, actorUserId: ownerId,
      testCaseIssueTypeId: "10001", localIdFieldId: "customfield_10002",
    });
  });

  afterEach(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [ownerId] });
    await resetDatabaseForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
      async ({ client }) => {
        await sqlRun(
          `UPDATE jira_artifact_backend_configs
           SET backend_type = 'xray_cloud', config_json = '{}', status = 'active', updated_at = clock_timestamp()::text
           WHERE workspace_id = @workspaceId AND project_id = @projectId`,
          { workspaceId, projectId },
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

  it("constructs the backend from the same-backend configuration that won the project lock", async () => {
    const replacementStarted = deferred<void>();
    const releaseReplacement = deferred<void>();
    const replacement = withAuthorizedJiraArtifactConfigurationLock(
      { workspaceId, projectId, actorUserId: ownerId },
      async ({ client }) => {
        await sqlRun(
          `UPDATE jira_artifact_backend_configs
           SET config_json = @configJson, updated_at = clock_timestamp()::text
           WHERE workspace_id = @workspaceId AND project_id = @projectId`,
          {
            workspaceId, projectId,
            configJson: JSON.stringify({ testCaseIssueTypeId: "10002", localIdFieldId: "customfield_10003" }),
          },
          client,
        );
        replacementStarted.resolve();
        await releaseReplacement.promise;
      },
    );
    await replacementStarted.promise;

    let createdFields: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/issue/QA-7?")) return json({ fields: { project: { id: providerProjectId, key: "QA" } } });
      if (url.endsWith("/search/jql")) return json({ issues: [] });
      if (url.endsWith("/issue") && init?.method === "POST") {
        createdFields = (JSON.parse(String(init.body)) as { fields: Record<string, unknown> }).fields;
        return json({ key: "QA-12" });
      }
      if (url.endsWith("/remotelink")) return json({});
      if (url.includes("/comment?")) return json({ comments: [], isLast: true });
      if (url.endsWith("/comment") && init?.method === "POST") return json({});
      throw new Error(`Unexpected Jira request: ${url}`);
    }));

    const publishing = publishConfiguredJiraTestCases({
      workspaceId, projectId, actorUserId: ownerId,
      testCases: [{ localId: "case-same-backend", targetUserStoryId: "QA-7", title: "Checkout", steps: [] }],
    });
    try {
      await expect(Promise.race([
        publishing.then(() => "settled", () => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ])).resolves.toBe("blocked");
    } finally {
      releaseReplacement.resolve();
      await replacement;
    }

    await expect(publishing).resolves.toMatchObject({ results: [{ success: true, azureTestCaseId: "QA-12" }] });
    expect(createdFields).toMatchObject({
      issuetype: { id: "10002" },
      customfield_10003: "case-same-backend",
    });
    expect(createdFields).not.toHaveProperty("customfield_10002");
  });

  it("completes a full pool of configured publishers without nested connection acquisition", async () => {
    authMocks.resolveJiraAccessToken.mockImplementation(async () => (
      await sqlGet<{ token: string }>(`SELECT 'access-token'::text AS token`)
    )?.token ?? "");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/issue/QA-7?")) return json({ fields: { project: { id: providerProjectId, key: "QA" } } });
      if (url.endsWith("/search/jql")) return json({ issues: [] });
      if (url.endsWith("/issue") && init?.method === "POST") {
        const fields = (JSON.parse(String(init.body)) as { fields: Record<string, unknown> }).fields;
        const localId = String(fields.customfield_10002);
        return json({ key: `QA-${localId.replace(/\D/g, "")}` });
      }
      if (url.endsWith("/remotelink")) return json({});
      if (url.includes("/comment?")) return json({ comments: [], isLast: true });
      if (url.endsWith("/comment") && init?.method === "POST") return json({});
      throw new Error(`Unexpected Jira request: ${url}`);
    }));

    const publications = Array.from({ length: 10 }, (_, index) => publishConfiguredJiraTestCases({
      workspaceId, projectId, actorUserId: ownerId,
      testCases: [{ localId: `case-pool-${index + 1}`, targetUserStoryId: "QA-7", title: `Pool ${index + 1}`, steps: [] }],
    }));
    const outcome = await Promise.race([
      Promise.all(publications),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);

    expect(outcome).not.toBe("timeout");
    expect(outcome).toEqual(expect.arrayContaining(Array.from({ length: 10 }, () => (
      expect.objectContaining({ results: [expect.objectContaining({ success: true })] })
    ))));
  }, 10_000);

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

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

import { afterAll, beforeAll, expect, it } from "vitest";

import { resetDatabaseForTests, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedProject, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  createExecutionRun,
  executionRunSettings,
  finishCase,
  finishRun,
  publishableCases,
} from "./execution-store.service";
import {
  TestDataResolutionError,
  decryptedRunTestData,
  resolveTestDataEntries,
  runTestDataMeta,
} from "./execution-test-data.service";

const workspaceId = uniqueTestId("ws_pw_data");
const userId = uniqueTestId("user_pw_data");
const projectId = uniqueTestId("project_pw_data");
const otherProjectId = uniqueTestId("project_pw_data_other");
const orgUrl = "https://dev.azure.com/pw-data";

const scope: ProjectScope = {
  workspaceId, projectId, azureProjectId: projectId, azureProjectName: "P", azureOrganizationUrl: orgUrl,
};

async function createRun(input: {
  testData?: Parameters<typeof createExecutionRun>[0]["testData"];
  cases?: Parameters<typeof createExecutionRun>[0]["cases"];
  runProjectId?: string;
}) {
  return createExecutionRun({
    workspaceId,
    projectId: input.runProjectId ?? projectId,
    planId: null,
    suiteId: null,
    requestedByUserId: userId,
    name: null,
    settings: {
      baseUrl: "https://app.example.test/start", executionNotes: "Use the staging tenant.", screenshotPolicy: "failures-only",
      headless: true, viewportWidth: 1920, viewportHeight: 1080,
    },
    testData: input.testData ?? [],
    configSnapshot: { transport: "stdio", endpoint: null, artifactBaseUrl: null },
    job: { userId, scope: { ...scope, projectId: input.runProjectId ?? projectId } },
    cases: input.cases ?? [{ title: "Manual case", steps: [{ action: "Open the app", expectedResult: "It loads" }] }],
  });
}

describeDb("Execution run test data (DB-backed)", () => {
  beforeAll(async () => {
    await seedUser({ id: userId, email: `${userId}@example.test` });
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
    await seedProject({ workspaceId, orgUrl, azureProjectId: otherProjectId });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
    await resetDatabaseForTests();
  });

  it("stores manual cases without Azure ids, freezes run settings, and encrypts secret test data at rest", async () => {
    const prepared = await resolveTestDataEntries({
      workspaceId, projectId,
      entries: [
        { title: "Username", isSecret: false, value: "qa@example.test" },
        { title: "Password", isSecret: true, value: "Sup3rS3cret!" },
      ],
    });
    const { runId } = await createRun({ testData: prepared });

    await expect(executionRunSettings(runId)).resolves.toEqual({
      baseUrl: "https://app.example.test/start",
      executionNotes: "Use the staging tenant.",
      screenshotPolicy: "failures-only",
      headless: true,
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    const caseRow = await sqlGet<{ azure_test_case_id: number | null; azure_plan_id: number | null; azure_suite_id: number | null }>(
      `SELECT azure_test_case_id, azure_plan_id, azure_suite_id FROM playwright_execution_cases WHERE run_id = @runId`, { runId },
    );
    expect(caseRow).toEqual({ azure_test_case_id: null, azure_plan_id: null, azure_suite_id: null });

    const secretRow = await sqlGet<{ value: string | null; encrypted_value: string | null }>(
      `SELECT value, encrypted_value FROM playwright_execution_run_data WHERE run_id = @runId AND title = 'Password'`, { runId },
    );
    expect(secretRow?.value).toBeNull();
    expect(secretRow?.encrypted_value).toBeTruthy();
    expect(secretRow?.encrypted_value).not.toContain("Sup3rS3cret!");

    await expect(runTestDataMeta(runId)).resolves.toEqual([
      { title: "Username", isSecret: false, value: "qa@example.test" },
      { title: "Password", isSecret: true, value: null },
    ]);
    await expect(decryptedRunTestData(runId)).resolves.toEqual([
      { title: "Username", isSecret: false, value: "qa@example.test" },
      { title: "Password", isSecret: true, value: "Sup3rS3cret!" },
    ]);

    await finishRun(runId, "passed");
  });

  it("copies saved secrets by reference on rerun and rejects cross-project references", async () => {
    const prepared = await resolveTestDataEntries({
      workspaceId, projectId,
      entries: [{ title: "Password", isSecret: true, value: "R3used!Value" }],
    });
    const { runId: sourceRunId } = await createRun({ testData: prepared });
    await finishRun(sourceRunId, "passed");

    const rerunPrepared = await resolveTestDataEntries({
      workspaceId, projectId,
      entries: [{ title: "Admin password", isSecret: true, fromRunId: sourceRunId, sourceTitle: "Password" }],
    });
    const { runId: rerunId } = await createRun({ testData: rerunPrepared });
    await expect(decryptedRunTestData(rerunId)).resolves.toEqual([
      { title: "Admin password", isSecret: true, value: "R3used!Value" },
    ]);
    await finishRun(rerunId, "passed");

    await expect(resolveTestDataEntries({
      workspaceId, projectId: otherProjectId,
      entries: [{ title: "Password", isSecret: true, fromRunId: sourceRunId }],
    })).rejects.toBeInstanceOf(TestDataResolutionError);
  });

  it("blocks a second active run per project and limits publication to point-carrying cases", async () => {
    const { runId } = await createRun({
      cases: [
        { title: "Manual case", steps: [{ action: "Open" }] },
        { testCaseId: 100, testPointId: 200, planId: 7, suiteId: 8, title: "Imported case", steps: [{ action: "Open", expectedResult: "Loads" }] },
      ],
    });

    await expect(createRun({})).rejects.toMatchObject({ code: "23505" });

    const cases = await sqlGet<{ manual_id: string; imported_id: string }>(
      `SELECT
         (SELECT id FROM playwright_execution_cases WHERE run_id = @runId AND azure_test_point_id IS NULL) AS manual_id,
         (SELECT id FROM playwright_execution_cases WHERE run_id = @runId AND azure_test_point_id IS NOT NULL) AS imported_id`,
      { runId },
    );
    await finishCase(cases!.manual_id, "failed", "Manual case failed.");
    await finishCase(cases!.imported_id, "passed");
    await finishRun(runId, "failed", "One or more test cases did not pass.");

    const publishable = await publishableCases(runId);
    expect(publishable).toHaveLength(1);
    expect(publishable[0]).toMatchObject({ azureTestCaseId: 100, azureTestPointId: 200, azurePlanId: 7, azureSuiteId: 8, outcome: "passed" });
  });
});

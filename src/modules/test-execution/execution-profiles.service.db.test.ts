import { afterAll, beforeAll, expect, it } from "vitest";

import { resetDatabaseForTests, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret } from "@/modules/security/encryption.service";
import { cleanupFixtures, describeDb, seedProject, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";
import {
  ProfileNameConflictError,
  ProfileNotFoundError,
  createExecutionProfile,
  deleteExecutionProfile,
  listExecutionProfiles,
  updateExecutionProfile,
} from "./execution-profiles.service";
import { TestDataResolutionError, resolveTestDataEntries } from "./execution-test-data.service";

const workspaceId = uniqueTestId("ws_pw_prof");
const userId = uniqueTestId("user_pw_prof");
const projectId = uniqueTestId("project_pw_prof");
const otherProjectId = uniqueTestId("project_pw_prof_other");
const orgUrl = "https://dev.azure.com/pw-prof";

function writeInput(overrides: Partial<Parameters<typeof createExecutionProfile>[0]> = {}) {
  return {
    workspaceId, projectId, userId,
    name: "Staging",
    baseUrl: "https://staging.example.test",
    executionNotes: "Use the staging tenant.",
    screenshotPolicy: "validation-points" as const,
    headless: false,
    viewportWidth: 1440,
    viewportHeight: 900,
    testData: [
      { title: "Username", isSecret: false, value: "qa@example.test" },
      { title: "Password", isSecret: true, value: "Pr0file!Secret" },
    ],
    ...overrides,
  };
}

describeDb("Execution profiles (DB-backed)", () => {
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

  it("creates profiles with encrypted secrets, lists metadata only, and rejects duplicate names case-insensitively", async () => {
    const profile = await createExecutionProfile(writeInput());
    expect(profile).toMatchObject({ headless: false, viewportWidth: 1440, viewportHeight: 900 });
    expect(profile.testData).toEqual([
      { title: "Username", isSecret: false, value: "qa@example.test" },
      { title: "Password", isSecret: true, value: null },
    ]);

    const stored = await sqlGet<{ value: string | null; encrypted_value: string | null }>(
      `SELECT value, encrypted_value FROM playwright_execution_profile_data WHERE profile_id = @id AND title = 'Password'`,
      { id: profile.id },
    );
    expect(stored?.value).toBeNull();
    expect(stored?.encrypted_value).toBeTruthy();

    await expect(createExecutionProfile(writeInput({ name: "  staging  " }))).rejects.toBeInstanceOf(ProfileNameConflictError);

    const listed = await listExecutionProfiles(workspaceId, projectId);
    expect(listed.map((entry) => entry.name)).toEqual(["Staging"]);
    await expect(listExecutionProfiles(workspaceId, otherProjectId)).resolves.toEqual([]);
  });

  it("keeps saved secret values across updates when the row carries no new value", async () => {
    const profile = await createExecutionProfile(writeInput({ name: "Keep-secrets" }));
    const updated = await updateExecutionProfile(profile.id, writeInput({
      name: "Keep-secrets renamed",
      headless: true,
      viewportWidth: 1280,
      viewportHeight: 720,
      testData: [
        { title: "Password", isSecret: true },
        { title: "OTP seed", isSecret: true, value: "N3w!Secret" },
      ],
    }));
    expect(updated.name).toBe("Keep-secrets renamed");
    expect(updated).toMatchObject({ headless: true, viewportWidth: 1280, viewportHeight: 720 });
    expect(updated.testData).toEqual([
      { title: "Password", isSecret: true, value: null },
      { title: "OTP seed", isSecret: true, value: null },
    ]);

    const kept = await resolveTestDataEntries({
      workspaceId, projectId,
      entries: [{ title: "Password", isSecret: true, fromProfileId: profile.id }],
    });
    expect(kept[0]).toMatchObject({ isSecret: true });
    expect(decryptSecret((kept[0] as { encrypted: Parameters<typeof decryptSecret>[0] }).encrypted)).toBe("Pr0file!Secret");
  });

  it("rejects keeping a secret that was never saved and updates against missing profiles", async () => {
    const profile = await createExecutionProfile(writeInput({ name: "Reject-unknown" }));
    await expect(updateExecutionProfile(profile.id, writeInput({
      name: "Reject-unknown",
      testData: [{ title: "Never saved", isSecret: true }],
    }))).rejects.toBeInstanceOf(TestDataResolutionError);
    await expect(updateExecutionProfile("missing-profile", writeInput())).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it("deletes profiles and invalidates saved-secret references to them", async () => {
    const profile = await createExecutionProfile(writeInput({ name: "Deleted" }));
    await expect(deleteExecutionProfile(profile.id, workspaceId, projectId)).resolves.toBe(true);
    await expect(deleteExecutionProfile(profile.id, workspaceId, projectId)).resolves.toBe(false);
    await expect(resolveTestDataEntries({
      workspaceId, projectId,
      entries: [{ title: "Password", isSecret: true, fromProfileId: profile.id }],
    })).rejects.toBeInstanceOf(TestDataResolutionError);
  });
});

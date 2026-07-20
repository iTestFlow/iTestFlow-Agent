import { afterAll, beforeAll, expect, it } from "vitest";

import { flushBackgroundWrites, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  getProjectKnowledgeLintIssues,
  runProjectKnowledgeLint,
  transitionProjectKnowledgeLintIssue,
} from "./project-knowledge-compiled.service";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

describeDb("project knowledge lint summary honesty", () => {
  const workspaceId = uniqueTestId("ws_lint");
  const projectId = uniqueTestId("project_lint");
  const organizationUrl = `https://dev.azure.com/${uniqueTestId("org")}`;
  const scope = {
    workspaceId,
    projectId,
    azureProjectId: projectId,
    azureProjectName: "Lint Project",
    azureOrganizationUrl: organizationUrl,
  };

  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: organizationUrl });
    await seedProject({ workspaceId, orgUrl: organizationUrl, azureProjectId: projectId, azureProjectName: "Lint Project" });
  });

  afterAll(async () => {
    // Lint completion records its activity through the deferred-write queue. Drain
    // it before deleting fixture rows so a late log insert cannot recreate a
    // workspace dependency after this cleanup has started.
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM project_knowledge_lint_issues WHERE workspace_id = @id`, { id: workspaceId });
    await sqlRun(`DELETE FROM project_knowledge_lint_runs WHERE workspace_id = @id`, { id: workspaceId });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE workspace_id = @id`, { id: workspaceId });
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
  });

  it("excludes ignored issues from the summary but keeps them in the list, and resolves them on re-run", async () => {
    // With no compiled snapshot, lint emits exactly one deterministic warning.
    const first = await runProjectKnowledgeLint({ scope });
    expect(first.summary).toMatchObject({ total: 1, warnings: 1 });
    const issue = first.issues.find((entry) => entry.issueType === "missing_knowledge_base");
    expect(issue).toBeDefined();

    await transitionProjectKnowledgeLintIssue({ scope, actor: "owner-1", issueId: issue!.id, action: "ignore" });

    // Re-running detects the same fingerprint; the upsert keeps it ignored, so it
    // stays in the list but no longer inflates the summary tiles.
    const second = await runProjectKnowledgeLint({ scope });
    expect(second.summary).toMatchObject({ total: 0, warnings: 0 });
    const stillListed = second.issues.find((entry) => entry.issueType === "missing_knowledge_base");
    expect(stillListed?.status).toBe("ignored");

    const stored = await getProjectKnowledgeLintIssues({ scope });
    expect(stored.find((entry) => entry.issueType === "missing_knowledge_base")?.status).toBe("ignored");
  });
});

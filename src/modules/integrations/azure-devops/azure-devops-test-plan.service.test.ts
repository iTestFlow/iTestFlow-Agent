import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createId: vi.fn(() => "audit-1"),
  nowIso: vi.fn(() => "2026-07-06T00:00:00.000Z"),
  sqlRun: vi.fn(async () => 1),
  enqueueBackgroundWrite: vi.fn((_label: string, operation: () => unknown) => operation()),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => db);

import { fakeAzureAdapter, projectScope } from "@/test/factories";
import { ProjectIsolationError, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { FinalApprovedTestCase, TestSuite } from "./azure-devops-types";
import { publishApprovedTestCases } from "./azure-devops-test-plan.service";

function approvedCase(overrides: Partial<FinalApprovedTestCase> = {}): FinalApprovedTestCase {
  return {
    localId: "case-1",
    targetUserStoryId: "123",
    title: "Successful checkout",
    steps: [{ action: "Open checkout", expectedResult: "Checkout is displayed" }],
    ...overrides,
  };
}

function suiteNode(overrides: Partial<TestSuite> = {}): TestSuite {
  return { id: "suite-1", name: "Root", planId: "plan-1", suiteType: "staticTestSuite", ...overrides };
}

// Adapter spies typed against the AzureDevOpsAdapter signatures so tsc keeps them honest.
const createOk = () =>
  vi.fn(async (input: { projectId: string; testCase: FinalApprovedTestCase }) => ({
    success: true,
    azureTestCaseId: `az-${input.testCase.localId}`,
  }));
const linkOk = () =>
  vi.fn<(input: { projectId: string; userStoryId: string; azureTestCaseId: string }) => Promise<{ success: boolean }>>(
    async () => ({ success: true }),
  );

describe("publishApprovedTestCases", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid project scope before touching the adapter", async () => {
    // Bare proxy: any adapter call would throw "Unexpected Azure adapter call".
    await expect(publishApprovedTestCases(fakeAzureAdapter(), {} as ProjectScope, {
      actor: "qa", targetUserStoryId: "123", suiteMode: "none", testCases: [approvedCase()],
    })).rejects.toBeInstanceOf(ProjectIsolationError);
    expect(db.sqlRun).not.toHaveBeenCalled();
  });

  it("throws before creating anything when the requirement parent suite is not in the plan tree", async () => {
    const createTestCase = createOk();
    const adapter = fakeAzureAdapter({
      fetchTestSuiteTree: vi.fn(async () => [suiteNode({ id: "other" })]),
      createTestCase,
    });
    await expect(publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-9",
      suiteMode: "requirement",
      parentSuiteId: "missing",
      testCases: [approvedCase()],
    })).rejects.toThrow("Parent suite missing was not found in test plan plan-9.");
    expect(createTestCase).not.toHaveBeenCalled();
    // Pre-validation failures happen before any work, so no audit row is written.
    expect(db.sqlRun).not.toHaveBeenCalled();
  });

  it("throws when the requirement parent suite is not a static suite", async () => {
    const createTestCase = createOk();
    const adapter = fakeAzureAdapter({
      fetchTestSuiteTree: vi.fn(async () => [
        suiteNode({ id: "root", children: [suiteNode({ id: "req-suite", suiteType: "requirementTestSuite" })] }),
      ]),
      createTestCase,
    });
    await expect(publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "requirement",
      parentSuiteId: "req-suite",
      testCases: [approvedCase()],
    })).rejects.toThrow("Only static suites can be selected as a parent for a requirement-based suite.");
    expect(createTestCase).not.toHaveBeenCalled();
  });

  it("finds a parent suite nested deep in the tree and publishes into a requirement suite", async () => {
    // The static target sits two levels down, under a non-static branch: lookup must recurse.
    const fetchTestSuiteTree = vi.fn(async () => [
      suiteNode({
        id: "root",
        children: [
          suiteNode({
            id: "branch",
            suiteType: "requirementTestSuite",
            children: [suiteNode({ id: "leaf", name: "Leaf" })],
          }),
        ],
      }),
    ]);
    const createRequirementBasedSuite = vi.fn(async () => ({
      success: true,
      suite: suiteNode({ id: "rs-1", name: "US 123 - Generated Test Cases" }),
    }));
    const adapter = fakeAzureAdapter({
      fetchTestSuiteTree,
      createTestCase: createOk(),
      linkTestCaseToUserStory: linkOk(),
      createRequirementBasedSuite,
    });

    const { results, requirementSuite } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "requirement",
      parentSuiteId: "leaf",
      testCases: [approvedCase()],
    });

    // Tree lookup and suite creation use the trusted scope project, not caller input.
    expect(fetchTestSuiteTree).toHaveBeenCalledWith({ projectId: "azure-project-1", testPlanId: "plan-1" });
    expect(createRequirementBasedSuite).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      testPlanId: "plan-1",
      parentSuiteId: "leaf",
      requirementId: "123",
      name: "US 123 - Generated Test Cases",
    });
    expect(requirementSuite).toEqual({ success: true, suiteId: "rs-1", suiteName: "US 123 - Generated Test Cases" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      localId: "case-1",
      azureTestCaseId: "az-case-1",
      success: true,
      suite: { success: true, suiteId: "rs-1" },
    });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        action: "azure_devops.publish_test_cases",
        status: "Success",
        entityId: "123",
        message: "Published 1 of 1 selected test cases.",
      }),
    );
  });

  it("chains create, link, then add-to-suite per test case in order (existing mode)", async () => {
    const calls: string[] = [];
    const createTestCase = vi.fn(async (input: { projectId: string; testCase: FinalApprovedTestCase }) => {
      calls.push(`create:${input.testCase.localId}`);
      return { success: true, azureTestCaseId: `az-${input.testCase.localId}` };
    });
    const linkTestCaseToUserStory = vi.fn(
      async (input: { projectId: string; userStoryId: string; azureTestCaseId: string }) => {
        calls.push(`link:${input.azureTestCaseId}`);
        return { success: true };
      },
    );
    const addTestCaseToSuite = vi.fn(
      async (input: { projectId: string; testPlanId: string; testSuiteId: string; azureTestCaseId: string }) => {
        calls.push(`suite:${input.azureTestCaseId}`);
        return { success: true };
      },
    );
    const adapter = fakeAzureAdapter({ createTestCase, linkTestCaseToUserStory, addTestCaseToSuite });

    const { results, requirementSuite } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "500",
      testPlanId: "plan-1",
      suiteMode: "existing",
      testSuiteId: "suite-7",
      testCases: [approvedCase({ localId: "case-1" }), approvedCase({ localId: "case-2" })],
    });

    // Each case runs its full chain before the next case starts.
    expect(calls).toEqual([
      "create:case-1", "link:az-case-1", "suite:az-case-1",
      "create:case-2", "link:az-case-2", "suite:az-case-2",
    ]);
    expect(linkTestCaseToUserStory).toHaveBeenCalledWith({
      projectId: "azure-project-1", userStoryId: "500", azureTestCaseId: "az-case-1",
    });
    expect(addTestCaseToSuite).toHaveBeenCalledWith({
      projectId: "azure-project-1", testPlanId: "plan-1", testSuiteId: "suite-7", azureTestCaseId: "az-case-1",
    });
    expect(requirementSuite).toBeUndefined();
    expect(results.map((result) => result.success)).toEqual([true, true]);
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({ status: "Success", message: "Published 2 of 2 selected test cases." }),
    );
  });

  it("continues past a failed creation and aggregates per-case results (existing mode)", async () => {
    const createTestCase = vi.fn(async (input: { projectId: string; testCase: FinalApprovedTestCase }) =>
      input.testCase.localId === "case-1"
        ? { success: false, error: "boom" }
        : { success: true, azureTestCaseId: `az-${input.testCase.localId}` });
    const linkTestCaseToUserStory = linkOk();
    const addTestCaseToSuite = vi.fn(async () => ({ success: true }));
    const adapter = fakeAzureAdapter({ createTestCase, linkTestCaseToUserStory, addTestCaseToSuite });

    const { results } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "existing",
      testSuiteId: "suite-7",
      testCases: [approvedCase({ localId: "case-1" }), approvedCase({ localId: "case-2" })],
    });

    // Downstream steps are skipped only for the failed case; the second still publishes.
    expect(linkTestCaseToUserStory).toHaveBeenCalledTimes(1);
    expect(addTestCaseToSuite).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({
      localId: "case-1",
      azureTestCaseId: undefined,
      success: false,
      create: { success: false, error: "boom" },
      link: { success: false, error: "Skipped because test case creation failed." },
      suite: { success: false, error: "Skipped because test case creation failed." },
      error: "boom",
    });
    expect(results[1]).toMatchObject({ localId: "case-2", azureTestCaseId: "az-case-2", success: true });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({ status: "Partial failure", message: "Published 1 of 2 selected test cases." }),
    );
  });

  it("treats a creation reported successful but missing an Azure ID as a failure", async () => {
    const linkTestCaseToUserStory = linkOk();
    const adapter = fakeAzureAdapter({
      createTestCase: vi.fn(async () => ({ success: true })),
      linkTestCaseToUserStory,
    });
    const { results } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa", targetUserStoryId: "123", suiteMode: "none", testCases: [approvedCase()],
    });
    expect(linkTestCaseToUserStory).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      success: false,
      link: { success: false, error: "Skipped because test case creation failed." },
    });
  });

  it("skips the suite add and fails the case when the user story link fails (existing mode)", async () => {
    const addTestCaseToSuite = vi.fn(async () => ({ success: true }));
    const adapter = fakeAzureAdapter({
      createTestCase: createOk(),
      linkTestCaseToUserStory: vi.fn(async () => ({ success: false, error: "link denied" })),
      addTestCaseToSuite,
    });
    const { results } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "existing",
      testSuiteId: "suite-7",
      testCases: [approvedCase()],
    });
    expect(addTestCaseToSuite).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      success: false,
      create: { success: true },
      link: { success: false, error: "link denied" },
      suite: { success: false, error: "Skipped because user story link failed." },
    });
  });

  it("fails the case on suite-add failure while preserving create and link successes", async () => {
    const adapter = fakeAzureAdapter({
      createTestCase: createOk(),
      linkTestCaseToUserStory: linkOk(),
      addTestCaseToSuite: vi.fn(async () => ({ success: false, error: "suite full" })),
    });
    const { results } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "existing",
      testSuiteId: "suite-7",
      testCases: [approvedCase()],
    });
    expect(results[0]).toMatchObject({
      success: false,
      create: { success: true },
      link: { success: true },
      suite: { success: false, error: "suite full" },
    });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({ status: "Failed", message: "Published 0 of 1 selected test cases." }),
    );
  });

  it("links without any suite work in none mode and omits the suite result", async () => {
    // Proxy adapter throws on any un-stubbed call, so suite/tree methods must not be reached.
    const adapter = fakeAzureAdapter({
      createTestCase: createOk(),
      linkTestCaseToUserStory: linkOk(),
    });
    const { results, requirementSuite } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa", targetUserStoryId: "123", suiteMode: "none", testCases: [approvedCase()],
    });
    expect(requirementSuite).toBeUndefined();
    expect(results[0].success).toBe(true);
    expect(results[0]).not.toHaveProperty("suite");
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({ status: "Success", message: "Created and linked 1 of 1 selected test cases." }),
    );
  });

  it("skips requirement suite creation entirely when no cases were linked", async () => {
    const createRequirementBasedSuite = vi.fn(async () => ({ success: true, suite: suiteNode() }));
    const adapter = fakeAzureAdapter({
      fetchTestSuiteTree: vi.fn(async () => [suiteNode({ id: "root" })]),
      createTestCase: createOk(),
      linkTestCaseToUserStory: vi.fn(async () => ({ success: false, error: "link denied" })),
      createRequirementBasedSuite,
    });
    const { results, requirementSuite } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "requirement",
      parentSuiteId: "root",
      testCases: [approvedCase()],
    });
    expect(createRequirementBasedSuite).not.toHaveBeenCalled();
    expect(requirementSuite).toEqual({
      success: false,
      error: "Skipped because no generated test cases were linked to the user story.",
    });
    expect(results[0].success).toBe(false);
    expect(results[0].suite).toEqual(requirementSuite);
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({ status: "Failed", message: "Published 0 of 1 selected test cases." }),
    );
  });

  it("fails every linked case when the requirement suite creation fails", async () => {
    const adapter = fakeAzureAdapter({
      fetchTestSuiteTree: vi.fn(async () => [suiteNode({ id: "root" })]),
      createTestCase: createOk(),
      linkTestCaseToUserStory: linkOk(),
      createRequirementBasedSuite: vi.fn(async () => ({ success: false, error: "no perms" })),
    });
    const { results, requirementSuite } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "requirement",
      parentSuiteId: "root",
      testCases: [approvedCase({ localId: "case-1" }), approvedCase({ localId: "case-2" })],
    });
    expect(requirementSuite).toEqual({ success: false, error: "no perms" });
    // Create and link succeeded per case, but the missing suite fails the overall publish.
    expect(results.map((result) => result.success)).toEqual([false, false]);
    expect(results.map((result) => result.link.success)).toEqual([true, true]);
    expect(results[0].suite).toEqual({ success: false, error: "no perms" });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({ status: "Failed", message: "Published 0 of 2 selected test cases." }),
    );
  });

  it("attaches the requirement suite only to linked cases and skips unlinked ones", async () => {
    const linkTestCaseToUserStory = vi.fn(
      async (input: { projectId: string; userStoryId: string; azureTestCaseId: string }) =>
        input.azureTestCaseId === "az-case-1"
          ? { success: true }
          : { success: false, error: "link denied" },
    );
    const adapter = fakeAzureAdapter({
      fetchTestSuiteTree: vi.fn(async () => [suiteNode({ id: "root" })]),
      createTestCase: createOk(),
      linkTestCaseToUserStory,
      createRequirementBasedSuite: vi.fn(async () => ({
        success: true,
        suite: suiteNode({ id: "rs-1", name: "US 123 - Generated Test Cases" }),
      })),
    });
    const { results, requirementSuite } = await publishApprovedTestCases(adapter, projectScope(), {
      actor: "qa",
      targetUserStoryId: "123",
      testPlanId: "plan-1",
      suiteMode: "requirement",
      parentSuiteId: "root",
      testCases: [approvedCase({ localId: "case-1" }), approvedCase({ localId: "case-2" })],
    });
    expect(requirementSuite).toEqual({ success: true, suiteId: "rs-1", suiteName: "US 123 - Generated Test Cases" });
    expect(results[0]).toMatchObject({ success: true, suite: { success: true, suiteId: "rs-1" } });
    expect(results[1]).toMatchObject({
      success: false,
      suite: { success: false, error: "Skipped because user story link failed." },
    });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({ status: "Partial failure", message: "Published 1 of 2 selected test cases." }),
    );
  });
});

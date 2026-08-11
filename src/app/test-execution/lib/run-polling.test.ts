import { describe, expect, it } from "vitest";

import type { RunDetailDeltaDto, RunDetailDto } from "@/modules/test-execution/report-assembler";

import { mergeRunDetailDelta, runPollDelay } from "./run-polling";

describe("runPollDelay", () => {
  it("polls fast at first, then relaxes, with failure backoff", () => {
    expect(runPollDelay(0, 0)).toBe(2_000);
    expect(runPollDelay(30_000, 0)).toBe(5_000);
    expect(runPollDelay(10 * 60_000, 0)).toBe(15_000);
    expect(runPollDelay(0, 1)).toBe(5_000);
    expect(runPollDelay(0, 5)).toBe(30_000);
  });
});

function baseDetail(): RunDetailDto {
  return {
    run: {
      id: "run-1",
      status: "running",
      outcome: null,
      storyWorkItemId: null,
      storyTitle: null,
      environmentProfileId: null,
      envConfig: {},
      summary: null,
      planSchemaVersion: "v2-natural",
      approvedBy: "user-1",
      approvedByName: "Approver",
      approvedAt: "t0",
      startedAt: "t0",
      finishedAt: null,
      errorMessage: null,
      createdAt: "t0",
    },
    cases: [
      {
        id: "case-1",
        orderIndex: 0,
        title: "Case",
        sourceKind: "manual",
        sourceSnapshotId: null,
        compileSource: "manual",
        compilePromptVersion: null,
        compileModel: null,
        status: "running",
        outcome: null,
        errorMessage: null,
        startedAt: "t0",
        finishedAt: null,
        steps: [
          {
            id: "step-1",
            orderIndex: 0,
            action: { instruction: "do it" },
            status: "running",
            outcome: null,
            observation: null,
            errorMessage: null,
            startedAt: "t0",
            finishedAt: null,
            actions: [
              {
                id: "action-1",
                orderIndex: 0,
                layer: "api",
                actionType: "api_request",
                safetyClass: "read",
                request: {},
                status: "completed",
                observation: {},
                errorCategory: null,
                errorMessage: null,
                startedAt: "t0",
                finishedAt: "t1",
              },
            ],
            artifacts: [],
          },
        ],
        artifacts: [],
      },
    ],
    runArtifacts: [],
    defectCandidates: [],
    job: { id: "job-1", status: "running", cancelRequestedAt: null },
    nextCursor: "10",
  };
}

function delta(overrides: Partial<RunDetailDeltaDto> = {}): RunDetailDeltaDto {
  const detail = baseDetail();
  return {
    run: { ...detail.run, approvedByName: null },
    changedCases: [],
    changedSteps: [],
    changedActions: [],
    artifacts: [],
    defectCandidates: [],
    job: detail.job,
    nextCursor: "20",
    hasMore: false,
    ...overrides,
  };
}

describe("mergeRunDetailDelta", () => {
  it("applies a status change on an EXISTING step with no new action row", () => {
    const previous = baseDetail();
    const merged = mergeRunDetailDelta(previous, delta({
      changedSteps: [{
        id: "step-1",
        caseRunId: "case-1",
        orderIndex: 0,
        action: { instruction: "do it" },
        status: "completed",
        outcome: "passed",
        observation: { summary: "done" },
        errorMessage: null,
        startedAt: "t0",
        finishedAt: "t2",
      }],
    }));
    expect(merged).not.toBeNull();
    const step = merged?.cases[0]?.steps[0];
    expect(step).toMatchObject({ id: "step-1", status: "completed", outcome: "passed" });
    // Existing child actions survive a parent-step update.
    expect(step?.actions).toHaveLength(1);
    expect(merged?.nextCursor).toBe("20");
  });

  it("upserts new actions into their step and keeps ordering", () => {
    const previous = baseDetail();
    const merged = mergeRunDetailDelta(previous, delta({
      changedActions: [{
        id: "action-2",
        stepRunId: "step-1",
        caseRunId: "case-1",
        orderIndex: 1,
        layer: "db",
        actionType: "db_select",
        safetyClass: "read",
        request: {},
        status: "completed",
        observation: {},
        errorCategory: null,
        errorMessage: null,
        startedAt: "t2",
        finishedAt: "t3",
      }],
    }));
    expect(merged?.cases[0]?.steps[0]?.actions.map((action) => action.id)).toEqual(["action-1", "action-2"]);
  });

  it("is idempotent: duplicate delivery of an already-known row changes nothing", () => {
    const previous = baseDetail();
    const duplicate = delta({
      changedActions: [{
        ...previous.cases[0].steps[0].actions[0],
        stepRunId: "step-1",
        caseRunId: "case-1",
      }],
    });
    const once = mergeRunDetailDelta(previous, duplicate);
    const twice = mergeRunDetailDelta(once as RunDetailDto, duplicate);
    expect(twice?.cases[0]?.steps[0]?.actions).toHaveLength(1);
  });

  it("returns null (full-refetch signal) when a changed row references an unknown parent", () => {
    const previous = baseDetail();
    expect(mergeRunDetailDelta(previous, delta({
      changedSteps: [{
        id: "step-x",
        caseRunId: "case-unknown",
        orderIndex: 0,
        action: null,
        status: "running",
        outcome: null,
        observation: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
      }],
    }))).toBeNull();
  });

  it("keeps the known approver display name across delta polls", () => {
    const previous = baseDetail();
    const merged = mergeRunDetailDelta(previous, delta());
    expect(merged?.run.approvedByName).toBe("Approver");
  });
});

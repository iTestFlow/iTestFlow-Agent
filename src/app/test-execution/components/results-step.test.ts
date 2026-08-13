// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunDetailDto } from "@/modules/test-execution/report-assembler";

import type { DraftCase } from "../lib/draft-storage";
import { ResultsStep, humanizeActionType, summarizeActionEvidence } from "./results-step";

afterEach(() => cleanup());

function detailWithCase(caseOverrides: Record<string, unknown> = {}): RunDetailDto {
  return {
    run: {
      id: "run-1",
      status: "completed",
      outcome: "failed",
      storyWorkItemId: null,
      storyTitle: null,
      environmentProfileId: null,
      envConfig: {},
      summary: null,
      planSchemaVersion: "v2-natural",
      approvedBy: "user-1",
      approvedByName: "Approver",
      approvedAt: "2026-08-12T00:00:00.000Z",
      startedAt: "2026-08-12T00:00:00.000Z",
      finishedAt: "2026-08-12T00:01:00.000Z",
      errorMessage: null,
      createdAt: "2026-08-12T00:00:00.000Z",
    },
    cases: [{
      id: "case-1",
      orderIndex: 0,
      title: "Checkout succeeds",
      sourceKind: "azure_test_case",
      sourceSnapshotId: "snapshot-1",
      azureTestCaseId: "456",
      plan: {
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Submit checkout", expectedResult: "Order is created", layerHint: "api" }],
      },
      compileSource: "azure_test_case",
      compilePromptVersion: null,
      compileModel: null,
      status: "completed",
      outcome: "failed",
      errorMessage: null,
      startedAt: "2026-08-12T00:00:00.000Z",
      finishedAt: "2026-08-12T00:01:00.000Z",
      steps: [{
        id: "step-1",
        orderIndex: 0,
        action: { instruction: "Submit checkout", expectedResult: "Order is created", layerHint: "api" },
        status: "completed",
        outcome: "failed",
        observation: null,
        errorMessage: null,
        startedAt: "2026-08-12T00:00:00.000Z",
        finishedAt: "2026-08-12T00:01:00.000Z",
        actions: [],
        artifacts: [],
      }],
      artifacts: [],
      ...caseOverrides,
    }],
    runArtifacts: [],
    defectCandidates: [],
    job: null,
  } as RunDetailDto;
}

function renderResults({
  detail = detailWithCase(),
  onEditCases = null,
  onRerunCases = null,
}: {
  detail?: RunDetailDto;
  onEditCases?: ((cases: DraftCase[]) => void) | null;
  onRerunCases?: ((cases: DraftCase[]) => void) | null;
} = {}) {
  return render(createElement(
    ResultsStep,
    {
      detail,
      artifactUrl: (artifactId: string) => `/artifacts/${artifactId}`,
      onEditCases,
      onRerunCases,
      onUpdateCandidate: async () => undefined,
      onPublishCandidate: async () => undefined,
      publishState: {},
    },
  ));
}

describe("multi-layer result evidence", () => {
  it("labels generic action types for the timeline", () => {
    expect(humanizeActionType("api.execute_operation")).toBe("Api Execute Operation");
    expect(humanizeActionType("db-select")).toBe("Db Select");
  });

  it("renders only allowlisted metadata and never arbitrary bodies or credentials", () => {
    // Persisted observations nest the layer payload under `data`.
    expect(
      summarizeActionEvidence(
        { method: "get", path: "/orders/42", authorization: "Bearer secret" },
        { data: { status: 200, rowCount: 1, body: { password: "secret" } } },
      ),
    ).toBe("GET /orders/42 · status 200 · 1 row(s)");
  });
});

describe("rerun controls", () => {
  it("stages one lossless case for editing without toggling its summary disclosure", async () => {
    const onEditCases = vi.fn();
    const user = userEvent.setup();
    renderResults({ onEditCases });

    const editButton = screen.getByRole("button", { name: "Edit & re-run Checkout succeeds" });
    const disclosure = editButton.closest("details");
    expect(disclosure).not.toHaveAttribute("open");

    await user.click(editButton);

    expect(onEditCases).toHaveBeenCalledWith([{
      title: "Checkout succeeds",
      sourceKind: "azure_test_case",
      azureTestCaseId: "456",
      plan: {
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Submit checkout", expectedResult: "Order is created", layerHint: "api" }],
      },
    }]);
    expect(disclosure).not.toHaveAttribute("open");
  });

  it("hides editing when no handler is supplied", () => {
    renderResults();

    expect(screen.queryByRole("button", { name: "Edit & re-run Checkout succeeds" })).not.toBeInTheDocument();
  });

  it("uses the shared fallback builder for failed-case reruns", async () => {
    const onRerunCases = vi.fn();
    const user = userEvent.setup();
    renderResults({
      onRerunCases,
      detail: detailWithCase({
        sourceKind: "manual",
        azureTestCaseId: null,
        plan: null,
        steps: [{
          id: "step-1",
          orderIndex: 0,
          action: { instruction: "  Retry checkout  ", expectedResult: "  It works  " },
          status: "completed",
          outcome: "failed",
          observation: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          actions: [],
          artifacts: [],
        }],
      }),
    });

    await user.click(screen.getByRole("button", { name: "Re-run failed cases (1)" }));

    expect(onRerunCases).toHaveBeenCalledWith([{
      title: "Checkout succeeds",
      sourceKind: "manual",
      azureTestCaseId: null,
      plan: {
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Retry checkout", expectedResult: "It works", layerHint: "auto" }],
      },
    }]);
  });

  it("hides failed-case reruns when no failed case can be staged", () => {
    renderResults({
      onRerunCases: vi.fn(),
      detail: detailWithCase({
        plan: null,
        steps: [{
          id: "step-1",
          orderIndex: 0,
          action: { instruction: "   " },
          status: "completed",
          outcome: "failed",
          observation: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          actions: [],
          artifacts: [],
        }],
      }),
    });

    expect(screen.queryByRole("button", { name: "Re-run failed cases (1)" })).not.toBeInTheDocument();
  });
});

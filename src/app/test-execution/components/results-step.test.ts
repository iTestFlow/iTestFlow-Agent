// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunDetailDto } from "@/modules/test-execution/report-assembler";

import type { DraftCase } from "../lib/draft-storage";
import {
  MAX_ACTION_PAYLOAD_CHARS,
  ResultsStep,
  formatActionPayload,
  humanizeActionType,
  summarizeActionEvidence,
} from "./results-step";

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

type ActionRef = RunDetailDto["cases"][number]["steps"][number]["actions"][number];

function layerAction(overrides: Partial<ActionRef> = {}): ActionRef {
  return {
    id: "action-1",
    orderIndex: 0,
    layer: "api",
    actionType: "api_request",
    safetyClass: "mutation",
    request: { method: "POST", path: "/orders", body: { sku: "A-1" } },
    status: "completed",
    observation: { summary: "Created", data: { status: 201, body: { id: 4021 } } },
    errorCategory: null,
    errorMessage: null,
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:01.000Z",
    ...overrides,
  };
}

function detailWithActions(actions: ActionRef[]): RunDetailDto {
  return detailWithCase({
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
      actions,
      artifacts: [],
    }],
  });
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

  it("offers the API request and response as a collapsed disclosure under the summary", () => {
    renderResults({ detail: detailWithActions([layerAction()]) });

    expect(screen.getByText(/POST \/orders · status 201/)).toBeInTheDocument();
    const disclosure = screen.getByText("Request & response").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText(/"sku": "A-1"/)).toBeInTheDocument();
    expect(screen.getByText(/"id": 4021/)).toBeInTheDocument();
  });

  it("keeps UI actions on today's summary-only rendering", () => {
    renderResults({
      detail: detailWithActions([layerAction({
        layer: "ui",
        actionType: "ui_action",
        safetyClass: "ui",
        request: { action: "fill", ref: "e2", value: "<not persisted>" },
        observation: { summary: "Field filled" },
      })]),
    });

    expect(screen.queryByText("Request & response")).not.toBeInTheDocument();
  });

  it("caps an oversized payload and says so", () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => ({ id: index, sku: `SKU-${index}` }));
    const payload = formatActionPayload({ data: { rows } });
    expect(payload?.truncated).toBe(true);
    expect(payload?.text).toHaveLength(MAX_ACTION_PAYLOAD_CHARS);

    renderResults({ detail: detailWithActions([layerAction({ observation: { data: { rows } } })]) });

    expect(screen.getByText(/^Truncated at/)).toBeInTheDocument();
  });

  it("omits the disclosure when the action persisted no payloads", () => {
    renderResults({ detail: detailWithActions([layerAction({ layer: "db", request: {}, observation: null })]) });

    expect(screen.queryByText("Request & response")).not.toBeInTheDocument();
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

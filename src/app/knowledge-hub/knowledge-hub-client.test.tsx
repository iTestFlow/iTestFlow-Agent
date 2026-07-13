// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changedKnowledgeEntryIdentities,
  KnowledgeCandidatesView,
  KnowledgeGovernanceView,
  knowledgePublishBlockedReason,
} from "./knowledge-hub-client";

afterEach(cleanup);

const candidate = {
  id: "candidate-1",
  title: "Checkout approval",
  content: "Orders above the threshold require approval.",
  status: "grounded" as const,
  sourceWorkItemIds: ["42"],
  evidenceRefs: [{ quote: "requires approval" }],
  citations: [{ workItemId: "42" }],
  updatedAt: "2026-07-13T10:00:00.000Z",
};

const governance = {
  rollout: {
    milestone3GaAt: null,
    reconciliationPublicationCount: 0,
    measuredDraftCount: 0,
    evaluationReady: false,
    minimumPercentageSample: false,
  },
  gates: {
    richerSynthesisEligible: false,
    semanticLintEligible: false,
    candidateAcceptanceEligible: false,
    hardTensionDraftRate: 0,
    confirmedLintMissRate: 0,
    integrationRequestCount: 0,
  },
  adrs: [{
    id: "adr-1",
    type: "quote_fidelity_checkpoint",
    status: "open",
    metricSnapshot: { manualReanchorRate: 0.08 },
    decision: null,
    createdAt: "2026-07-13T10:00:00.000Z",
    decidedAt: null,
  }],
};

describe("Knowledge Hub candidate governance UI", () => {
  it("shows candidate evidence to members without mutation actions", () => {
    render(<KnowledgeCandidatesView
      candidates={[candidate]}
      status="all"
      loading={false}
      canManage={false}
      onStatusChange={vi.fn()}
      onAction={vi.fn()}
    />);

    expect(screen.getByText("Checkout approval")).toBeTruthy();
    expect(screen.getByText("Sources: 42")).toBeTruthy();
    expect(screen.getByText("Evidence and citations")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request Integration" })).toBeNull();
  });

  it("lets owners filter and request integration for grounded candidates", async () => {
    const onStatusChange = vi.fn();
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<KnowledgeCandidatesView
      candidates={[candidate]}
      status="all"
      loading={false}
      canManage
      onStatusChange={onStatusChange}
      onAction={onAction}
    />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "grounded" } });
    fireEvent.click(screen.getByRole("button", { name: "Request Integration" }));

    expect(onStatusChange).toHaveBeenCalledWith("grounded");
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("candidate-1", "request_integration"));
  });

  it("restricts GA start and ADR decisions to governance managers", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const view = render(<KnowledgeGovernanceView
      governance={governance}
      loading={false}
      canManage={false}
      onStart={onStart}
      onDecide={onDecide}
    />);

    expect(screen.getByText(/Publications are not counted/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start Milestone 3 GA" })).toBeNull();
    expect(screen.queryByPlaceholderText("Record the owner decision")).toBeNull();

    view.rerender(<KnowledgeGovernanceView
      governance={governance}
      loading={false}
      canManage
      onStart={onStart}
      onDecide={onDecide}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Start Milestone 3 GA" }));
    fireEvent.change(screen.getByPlaceholderText("Record the owner decision"), {
      target: { value: "Keep strict verification enabled." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("adr-1", "Keep strict verification enabled."));
  });
});

describe("knowledge publish availability", () => {
  it("prioritizes the remaining review issue count", () => {
    expect(knowledgePublishBlockedReason({
      status: "blocked",
      blockerCount: 81,
      regenerateRequired: true,
    })).toBe("Blocked: 81 review issues remain.");
  });

  it("explains regeneration and incomplete review gates", () => {
    expect(knowledgePublishBlockedReason({
      status: "ready_for_review",
      blockerCount: 0,
      regenerateRequired: true,
    })).toBe("Blocked: Source changes require refreshing sources and regenerating this draft.");

    expect(knowledgePublishBlockedReason({
      status: "blocked",
      blockerCount: 0,
    })).toBe("Blocked: Complete and re-check the review before publishing.");
  });

  it("returns no reason for a publishable draft", () => {
    expect(knowledgePublishBlockedReason({
      status: "ready_for_review",
      blockerCount: 0,
    })).toBeNull();
  });
});

describe("review result highlighting", () => {
  it("identifies the staged combined entry without treating removed versions as results", () => {
    const versionOne = {
      term: "payment gateway",
      type: "term" as const,
      definition: "Routes card payments.",
      sourceWorkItemIds: ["10"],
      evidence: "Card payment evidence.",
    };
    const versionTwo = {
      term: "payment gateway",
      type: "system" as const,
      definition: "Routes bank transfers.",
      sourceWorkItemIds: ["11"],
      evidence: "Bank transfer evidence.",
    };
    const base = {
      modules: [],
      businessRules: [],
      stateTransitions: [],
      glossary: [versionOne, versionTwo],
      crossDependencies: [],
    };
    const combined = {
      ...versionOne,
      definition: versionTwo.definition,
      sourceWorkItemIds: ["10", "11"],
      evidence: "Card payment evidence. | Bank transfer evidence.",
    };

    const identities = changedKnowledgeEntryIdentities(base, { ...base, glossary: [combined] });

    expect(identities).toHaveLength(1);
    expect(identities[0]).toContain("glossary:");
    expect(identities[0]).toContain("Routes bank transfers.");
  });
});

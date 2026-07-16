// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeProjectKnowledgeBlockers,
  type ProjectKnowledgeDraftBlocker,
  type ProjectKnowledgeReviewSummary,
} from "@/modules/rag/project-knowledge-review.contracts";
import { KnowledgeConflictReview, KnowledgeReviewWorkspace } from "./knowledge-review-workspace";

const emptyKnowledge = { modules: [], businessRules: [], stateTransitions: [], glossary: [], crossDependencies: [] };
const summary: ProjectKnowledgeReviewSummary = {
  attemptedEvidenceRepairs: 0,
  automaticEvidenceRepairs: 0,
  automaticDuplicateConsolidations: 0,
  preConsolidationDuplicateIdentities: 0,
  paraphraseMerges: 0,
  rekeys: 0,
  atomicExtractionFailures: 0,
  possibleTensions: 0,
  wordingCarryOvers: 0,
  unresolvedEvidenceEntries: 0,
  remainingBlockers: 0,
  byType: {},
  byCategory: {},
};

afterEach(cleanup);

function renderWorkspace(blockers: ProjectKnowledgeDraftBlocker[] = []) {
  return render(<KnowledgeReviewWorkspace
    draftId="draft-1"
    status={blockers.length ? "blocked" : "ready_to_publish"}
    blockers={blockers}
    reviewSummary={{ ...summary, remainingBlockers: blockers.length }}
    proposedKnowledge={emptyKnowledge}
    busy={false}
    onLoadReviewContext={vi.fn()}
    onResolve={vi.fn()}
    onRebase={vi.fn()}
    onRegenerate={vi.fn()}
  />);
}

describe("KnowledgeReviewWorkspace v4 compatibility renderer", () => {
  it("shows the explicit-publication handoff when there are no semantic conflicts", () => {
    renderWorkspace();
    expect(screen.getByText("Draft checks passed")).toBeTruthy();
    expect(screen.getByText(/one explicit Publish action/)).toBeTruthy();
  });

  it("never renders legacy evidence repair or rebase controls", () => {
    renderWorkspace([{
      id: "missing:module:checkout",
      type: "missing_evidence_refs",
      category: "module",
      entryKey: "checkout",
      message: "Evidence link required",
      sourceWorkItemIds: ["42"],
    }]);
    expect(screen.queryByText("Evidence link required")).toBeNull();
    expect(screen.queryByRole("button", { name: /rebase/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /accept suggested evidence/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save decisions and re-check/i })).toBeNull();
  });

  it("reports only genuine semantic conflict blockers", () => {
    const conflict = {
      id: "hard:rule:retry",
      type: "hard_conflict",
      category: "hard_conflict",
      entryKey: "retry",
      message: "Retry counts disagree.",
      affectedCategory: "business_rule",
      identityKey: "retry",
      subject: "Retry count",
      conflictType: "incompatible_concrete_value",
      participants: [],
      evidenceIdentical: false,
    } as ProjectKnowledgeDraftBlocker;
    renderWorkspace([conflict, { ...conflict, id: "hard:rule:timeout", entryKey: "timeout" }]);
    expect(screen.getByText("2 knowledge conflicts")).toBeTruthy();
    expect(screen.getByText(/v4 conflict-only workspace/)).toBeTruthy();
  });

  it("renders normalized malformed-basis conflicts without crashing", () => {
    const blockers = normalizeProjectKnowledgeBlockers([{
      type: "hard_conflict",
      identityKey: "retry-count",
      affectedCategory: "business_rule",
      conflictBasis: { object: "retry", property: "count", values: "oops" },
    }]);

    renderWorkspace(blockers);
    expect(screen.getByText("1 knowledge conflict")).toBeTruthy();
  });
});

describe("KnowledgeConflictReview", () => {
  it("renders legacy conflict cards without an atomic basis", () => {
    render(<KnowledgeConflictReview
      page={{
        draftVersion: "legacy-draft",
        counts: { total: 1, resolved: 0, remaining: 1 },
        page: 1,
        pageSize: 50,
        pageCount: 1,
        conflicts: [{
          conflictId: "legacy-conflict",
          identityKey: "identity:module:checkout",
          subject: "identity:module:checkout",
          affectedCategory: "module",
          conflictType: "duplicate_identity",
          participants: [],
        }],
      }}
      loading={false}
      decisions={{}}
      active={false}
      onDecision={vi.fn()}
      onPage={vi.fn()}
      onReset={vi.fn()}
      onApply={vi.fn()}
    />);

    expect(screen.getByText("Different versions")).toBeTruthy();
    expect(screen.getByText(/These source-backed entries disagree/)).toBeTruthy();
  });

  it("renders possible-tension labels with a real em dash", () => {
    render(<KnowledgeConflictReview
      page={{
        draftVersion: "tension-draft",
        counts: { total: 0, resolved: 0, remaining: 0 },
        page: 1,
        pageSize: 50,
        pageCount: 1,
        conflicts: [],
        possibleTensions: [{
          category: "business_rule",
          subject: "identity:business_rule:purchase-notification",
          entryKeys: ["purchase-notification", "purchase-notification-a1b2c3d4"],
          reason: "different_atomic_identity",
        }],
      }}
      loading={false}
      decisions={{}}
      active={false}
      onDecision={vi.fn()}
      onPage={vi.fn()}
      onReset={vi.fn()}
      onApply={vi.fn()}
    />);

    expect(screen.getByText("Purchase Notification")).toBeTruthy();
    expect(screen.getByText("— Different Atomic Identity")).toBeTruthy();
  });

  it("restores the established version comparison UI while submitting compact decisions", () => {
    const onDecision = vi.fn();

    render(<KnowledgeConflictReview
      page={{
        draftVersion: "draft-version-1",
        counts: { total: 1, resolved: 0, remaining: 1 },
        page: 1,
        pageSize: 50,
        pageCount: 1,
        conflicts: [{
          conflictId: "conflict-1",
          identityKey: "retry-policy",
          subject: "Retry policy",
          affectedCategory: "business_rule",
          conflictType: "incompatible_concrete_value",
          conflictBasis: {
            object: "retry",
            property: "count",
            values: [
              { participantId: "participant-1", operator: "eq", value: "3", valueType: "number" },
              { participantId: "participant-2", operator: "eq", value: "5", valueType: "number" },
            ],
          },
          participants: [{
            participantId: "participant-1",
            entryKey: "retry-three-times",
            fields: { rule: "Retry three times", sourceField: "Acceptance Criteria", moduleName: "Checkout" },
            evidence: [{ sourceField: "Acceptance Criteria", quote: "Retry failed payments three times.", sourceWorkItemId: "42" }],
          }, {
            participantId: "participant-2",
            entryKey: "retry-five-times",
            fields: { rule: "Retry five times", sourceField: "Description", moduleName: "Checkout" },
            evidence: [{ sourceField: "Description", quote: "Retry failed payments up to five times.", sourceWorkItemId: "57" }],
          }],
        }],
      }}
      loading={false}
      decisions={{}}
      active={false}
      onDecision={onDecision}
      onPage={vi.fn()}
      onReset={vi.fn()}
      onApply={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "1 knowledge conflict needs review before publishing" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Version 1" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Version 2" })).toBeTruthy();
    expect(screen.getAllByText("Source evidence")).toHaveLength(2);
    expect(screen.getByText(/Retry failed payments three times/)).toBeTruthy();
    expect(screen.getByText(/Atomic claim: Retry · Count/)).toBeTruthy();
    expect(screen.getByText(/Version 1: equals 3/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep version 2" }));
    expect(onDecision).toHaveBeenCalledWith({
      conflictId: "conflict-1",
      action: "keep",
      participantId: "participant-2",
    });

    fireEvent.click(screen.getByRole("button", { name: "Combine versions" }));
    expect(screen.getByRole("group", { name: "Combine supported versions" })).toBeTruthy();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Preview combined entry" })).toBeNull();
    expect(screen.queryByText("Review combined entry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to choices" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use combined version" }));
    expect(onDecision).toHaveBeenLastCalledWith({
      conflictId: "conflict-1",
      action: "combine",
      fieldParticipants: {
        rule: "participant-1",
        sourceField: "participant-1",
        moduleName: "participant-1",
      },
    });
    expect(screen.queryByText("Evidence link required")).toBeNull();
    expect(screen.queryByRole("button", { name: /rebase/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save decisions and re-check/i })).toBeNull();
  });
});

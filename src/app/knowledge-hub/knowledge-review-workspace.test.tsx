// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { ProjectKnowledgeDraftBlocker, ProjectKnowledgeReviewSummary } from "@/modules/rag/project-knowledge-review.contracts";
import { KnowledgeReviewWorkspace } from "./knowledge-review-workspace";

afterEach(cleanup);

const knowledge = {
  modules: [{
    id: "checkout",
    name: "Secure checkout",
    description: "Customers complete checkout.",
    sourceWorkItemIds: ["42"],
    evidence: "Customers complete checkout securely.",
  }],
  businessRules: [],
  stateTransitions: [],
  glossary: [],
  crossDependencies: [],
};

function missingBlocker(index = 0): ProjectKnowledgeDraftBlocker {
  return {
    id: `missing-${index}`,
    type: "missing_evidence_refs",
    category: "module",
    entryKey: index ? `entry-${index}` : "checkout",
    sourceWorkItemIds: [String(42 + index)],
    message: "This entry needs an immutable evidence reference.",
  };
}

function summary(blockers: ProjectKnowledgeDraftBlocker[]): ProjectKnowledgeReviewSummary {
  return {
    attemptedEvidenceRepairs: blockers.length + 2,
    automaticEvidenceRepairs: 2,
    automaticDuplicateConsolidations: 0,
    unresolvedEvidenceEntries: blockers.length,
    remainingBlockers: blockers.length,
    byType: { missing_evidence_refs: blockers.length },
    byCategory: { module: blockers.length },
  };
}

function glossaryConflictFixture() {
  const firstEntry = {
    term: "promo code",
    type: "term" as const,
    definition: "A code entered during checkout.",
    sourceWorkItemIds: ["10"],
    evidence: "Enter a promo code at checkout.",
    evidenceRefs: [],
  };
  const secondEntry = {
    term: "promo code",
    type: "business_entity" as const,
    definition: "A discount token issued by Marketing.",
    sourceWorkItemIds: ["11"],
    evidence: "Marketing issues discount tokens.",
    evidenceRefs: [],
  };
  const participant = (id: string, entry: ProjectKnowledgeBase["glossary"][number]) => ({
    participantId: id,
    category: "glossary" as const,
    entryKey: "promo code",
    entry,
    projection: { term: entry.term, type: entry.type, definition: entry.definition },
    semanticHash: `semantic-${id}`,
    sourceWorkItemIds: entry.sourceWorkItemIds,
    sourceSnapshotIds: [],
    evidenceRefs: entry.evidenceRefs ?? [],
    evidence: entry.evidence,
  });
  const conflict: Extract<ProjectKnowledgeDraftBlocker, { type: "hard_conflict" }> = {
    id: "promo-code-conflict",
    type: "hard_conflict",
    category: "hard_conflict",
    affectedCategory: "glossary",
    entryKey: "promo-code-conflict",
    identityKey: "promo-code-conflict",
    subject: "identity:glossary:promo code",
    conflictType: "duplicate_identity",
    participants: [participant("one", firstEntry), participant("two", secondEntry)],
    message: "These source-backed entries disagree and require a reviewer decision.",
  };
  return { firstEntry, secondEntry, participant, conflict };
}

function renderWorkspace(overrides: Partial<Parameters<typeof KnowledgeReviewWorkspace>[0]> = {}) {
  const blockers = overrides.blockers ?? [missingBlocker()];
  const props: Parameters<typeof KnowledgeReviewWorkspace>[0] = {
    draftId: "draft-1",
    status: "blocked",
    blockers,
    reviewSummary: summary(blockers),
    proposedKnowledge: knowledge,
    busy: false,
    onLoadReviewContext: vi.fn().mockResolvedValue({ entries: [], sources: [] }),
    onResolve: vi.fn().mockResolvedValue(undefined),
    onRebase: vi.fn().mockResolvedValue(undefined),
    onRegenerate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...render(<KnowledgeReviewWorkspace {...props} />), props };
}

describe("KnowledgeReviewWorkspace", () => {
  it("reports duplicates as automatically consolidated instead of review findings", () => {
    renderWorkspace({
      blockers: [],
      reviewSummary: {
        ...summary([]),
        automaticEvidenceRepairs: 0,
        automaticDuplicateConsolidations: 13,
      },
    });

    expect(screen.getByText("Review checks passed")).toBeTruthy();
    expect(screen.getByText(/13 duplicate entries were consolidated automatically/)).toBeTruthy();
    expect(screen.queryByText("13 unresolved")).toBeNull();
  });

  it("turns repeated blocker codes into meaningful, paginated entry issues", () => {
    const blockers = Array.from({ length: 12 }, (_, index) => missingBlocker(index));
    renderWorkspace({ blockers, reviewSummary: summary(blockers) });

    expect(screen.getByRole("heading", { name: "Publication review required" })).toBeTruthy();
    expect(screen.getByText("2 evidence links were repaired automatically; Review only the entries below that still need a decision.")).toBeTruthy();
    expect(screen.getAllByText("Evidence link required").length).toBeGreaterThan(0);
    expect(screen.getByText("checkout")).toBeTruthy();
    expect(screen.getByText("Showing 1-10 of 12")).toBeTruthy();
    expect(screen.queryByLabelText("Complete reviewed proposal")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("Showing 11-12 of 12")).toBeTruthy();
  });

  it("keeps JSON advanced and reports path-aware schema errors locally", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /Advanced JSON/ }));
    const editor = await screen.findByLabelText("Complete reviewed proposal");
    fireEvent.change(editor, { target: { value: '{"modules":[{"id":"invalid"}]}' } });
    fireEvent.click(screen.getByRole("button", { name: "Apply JSON to review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/modules\.0/);
  });

  it("adds an exact reviewer reference from immutable source text before validation", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      onResolve,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [{
          category: "module",
          entryKey: "checkout",
          sources: [{
            sourceSnapshotId: "snapshot-42",
            sourceWorkItemId: "42",
            workItemType: "User Story",
            workItemTitle: "Secure checkout",
            workItemUrl: "https://dev.azure.com/acme/shop/_workitems/edit/42",
            adoRevision: 3,
            sourceUpdatedAt: "2026-07-12T10:00:00.000Z",
            capturedAt: "2026-07-12T10:05:00.000Z",
            fields: [{ sourceField: "description", text: "Customers complete checkout securely." }],
          }],
        }],
        sources: [],
      }),
    });

    await screen.findByDisplayValue("Customers complete checkout securely.");
    fireEvent.click(screen.getByRole("button", { name: "Use entire field" }));
    fireEvent.click(screen.getByRole("button", { name: "Add evidence reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Validate review changes" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    const reviewed = onResolve.mock.calls[0][0];
    expect(reviewed.modules[0].evidenceRefs).toEqual([expect.objectContaining({
      sourceSnapshotId: "snapshot-42",
      sourceWorkItemId: "42",
      sourceField: "description",
      quote: "Customers complete checkout securely.",
      origin: "reviewer_reanchored",
      verification: "exact",
    })]);
  });

  it("applies a structured replay choice without exposing raw JSON", () => {
    const replay: ProjectKnowledgeDraftBlocker = {
      id: "replay-1",
      type: "replay_conflict",
      category: "module",
      entryKey: "checkout",
      message: "Choose the entry to keep.",
      operationId: "operation-1",
      result: "semantic_conflict",
      base: knowledge.modules[0],
      latest: { ...knowledge.modules[0], name: "Latest checkout" },
      proposed: { ...knowledge.modules[0], name: "Proposed checkout" },
      actions: ["keep_latest", "use_proposed", "edit_proposed"],
    };
    renderWorkspace({
      blockers: [replay],
      reviewSummary: {
        ...summary([]),
        automaticEvidenceRepairs: 0,
        remainingBlockers: 1,
        byType: { replay_conflict: 1 },
        byCategory: { module: 1 },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Keep latest" }));
    expect(screen.getByRole("button", { name: "Validate review changes" })).not.toBeDisabled();
  });

  it("shows readable candidate values and source links instead of internal fingerprints", async () => {
    const identityKey = "17122614f639e28b6f4fc47955b833abcae3c11bdafc7b01e2c791bf44104e11";
    const entry = {
      id: "retry-count-five",
      rule: "Maximum retry count is 5.",
      sourceField: "acceptanceCriteria",
      moduleName: "payments",
      sourceWorkItemIds: ["42"],
      evidence: "Retry count is 5.",
      evidenceRefs: [{
        sourceSnapshotId: "snapshot-42",
        sourceWorkItemId: "42",
        sourceField: "acceptanceCriteria" as const,
        quote: "Retry count is 5.",
        origin: "generated_v2" as const,
        verification: "exact" as const,
      }],
    };
    const conflict: ProjectKnowledgeDraftBlocker = {
      id: "hard-conflict-1",
      type: "hard_conflict",
      category: "hard_conflict",
      affectedCategory: "business_rule",
      entryKey: identityKey,
      identityKey,
      subject: "payments:maximum retry count",
      conflictType: "incompatible_concrete_value",
      participants: [{
        participantId: "participant-1",
        category: "business_rule",
        entryKey: "retry-count-five",
        entry,
        projection: { rule: entry.rule, sourceField: entry.sourceField, moduleName: entry.moduleName },
        semanticHash: "semantic-hash-1",
        concreteValue: "5",
        sourceWorkItemIds: ["42"],
        sourceSnapshotIds: ["snapshot-42"],
        evidenceRefs: entry.evidenceRefs,
        evidence: "Retry count is 5.",
      }],
      message: "These source-backed entries disagree and require a reviewer decision.",
    };
    renderWorkspace({
      blockers: [conflict],
      reviewSummary: {
        ...summary([]),
        automaticEvidenceRepairs: 0,
        remainingBlockers: 1,
        byType: { hard_conflict: 1 },
        byCategory: { business_rule: 1 },
      },
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [],
        sources: [{
          sourceSnapshotId: "snapshot-42",
          sourceWorkItemId: "42",
          workItemType: "User Story",
          workItemTitle: "Limit payment retries",
          workItemUrl: "https://dev.azure.com/acme/shop/_workitems/edit/42",
          adoRevision: 2,
          sourceUpdatedAt: "2026-07-12T10:00:00.000Z",
          capturedAt: "2026-07-12T10:05:00.000Z",
          fields: [{ sourceField: "acceptanceCriteria", text: "Retry count is 5." }],
        }],
      }),
    });

    expect(screen.getByRole("heading", { name: "1 knowledge conflict needs review before publishing" })).toBeTruthy();
    expect(screen.getByText("Conflicting values")).toBeTruthy();
    expect(screen.getByText("Payments \u00b7 Maximum retry count")).toBeTruthy();
    expect(screen.queryByLabelText("Review issue summary")).toBeNull();
    expect(screen.queryByRole("group", { name: "Filter review issues by category" })).toBeNull();
    expect(screen.getByText("Maximum retry count is 5.")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Open work item 42 in Azure DevOps" })).toHaveTextContent("User Story #42 — Limit payment retries");
    expect(screen.queryByText(identityKey)).toBeNull();
    expect(screen.queryByText("snapshot-42")).toBeNull();
    expect(screen.queryByText("semantic-hash-1")).toBeNull();
    expect(screen.queryByText("Concrete Value")).toBeNull();
  });

  it("keeps the exact candidate selected by the reviewer", async () => {
    const { firstEntry, secondEntry, conflict } = glossaryConflictFixture();
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      blockers: [conflict],
      proposedKnowledge: { ...knowledge, glossary: [firstEntry, secondEntry] },
      reviewSummary: {
        ...summary([]),
        remainingBlockers: 1,
        byType: { hard_conflict: 1 },
        byCategory: { glossary: 1 },
      },
      onResolve,
    });

    fireEvent.click(screen.getByRole("button", { name: "Keep version 2" }));
    expect(screen.getByText("Version 2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save decisions and re-check" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].glossary).toEqual([expect.objectContaining({
      term: "promo code",
      type: "business_entity",
      definition: "A discount token issued by Marketing.",
    })]);
  });

  it("replaces logical identity aliases after provenance edits without removing unrelated Unicode entries", async () => {
    const fixture = glossaryConflictFixture();
    const firstEntry = { ...fixture.firstEntry, term: "客户 流程" };
    const secondEntry = { ...fixture.secondEntry, term: "客户_流程" };
    const unrelatedEntry = {
      ...fixture.firstEntry,
      term: "支付 流程",
      definition: "The payment workflow.",
      sourceWorkItemIds: ["99"],
      evidence: "Payment workflow evidence.",
    };
    const conflict: ProjectKnowledgeDraftBlocker = {
      ...fixture.conflict,
      subject: "identity:glossary:客户-流程",
      participants: [
        fixture.participant("one", firstEntry),
        fixture.participant("two", secondEntry),
      ],
    };
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      blockers: [conflict],
      proposedKnowledge: { ...knowledge, glossary: [firstEntry, secondEntry, unrelatedEntry] },
      reviewSummary: {
        ...summary([]),
        automaticEvidenceRepairs: 0,
        remainingBlockers: 1,
        byType: { hard_conflict: 1 },
        byCategory: { glossary: 1 },
      },
      onResolve,
    });

    fireEvent.click(screen.getByRole("button", { name: /Advanced JSON/ }));
    const editedKnowledge = {
      ...knowledge,
      glossary: [
        { ...firstEntry, sourceWorkItemIds: ["10", "12"], evidence: "Reviewer-updated provenance." },
        secondEntry,
        unrelatedEntry,
      ],
    };
    fireEvent.change(screen.getByLabelText("Complete reviewed proposal"), {
      target: { value: JSON.stringify(editedKnowledge, null, 2) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply JSON to review" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep version 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save decisions and re-check" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].glossary).toHaveLength(2);
    expect(onResolve.mock.calls[0][0].glossary).toEqual(expect.arrayContaining([
      expect.objectContaining({ term: "客户_流程", definition: secondEntry.definition }),
      expect.objectContaining({ term: "支付 流程", definition: unrelatedEntry.definition }),
    ]));
  });

  it("builds a mixed-field combination and keeps provenance only from selected versions", async () => {
    const { firstEntry, secondEntry, participant, conflict } = glossaryConflictFixture();
    const unselectedEntry = {
      ...firstEntry,
      type: "role" as const,
      definition: "An unselected third definition.",
      sourceWorkItemIds: ["12"],
      evidence: "Unselected third evidence.",
    };
    const threeVersionConflict: ProjectKnowledgeDraftBlocker = {
      ...conflict,
      participants: [...conflict.participants, participant("three", unselectedEntry)],
    };
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      blockers: [threeVersionConflict],
      proposedKnowledge: { ...knowledge, glossary: [firstEntry, secondEntry, unselectedEntry] },
      reviewSummary: {
        ...summary([]),
        automaticEvidenceRepairs: 0,
        remainingBlockers: 1,
        byType: { hard_conflict: 1 },
        byCategory: { glossary: 1 },
      },
      onResolve,
    });

    fireEvent.click(screen.getByRole("button", { name: "Combine entries" }));
    const createButton = screen.getByRole("button", { name: "Create combined entry" });
    expect(createButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Choose source version for Type"), { target: { value: "0" } });
    expect(createButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Choose source version for Definition"), { target: { value: "1" } });
    expect(createButton).not.toBeDisabled();
    fireEvent.click(createButton);
    expect(screen.getByText("Entries combined")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save decisions and re-check" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].glossary).toEqual([expect.objectContaining({
      type: "term",
      definition: "A discount token issued by Marketing.",
      sourceWorkItemIds: ["10", "11"],
      evidence: "Enter a promo code at checkout. | Marketing issues discount tokens.",
    })]);
    expect(onResolve.mock.calls[0][0].glossary[0].sourceWorkItemIds).not.toContain("12");
    expect(onResolve.mock.calls[0][0].glossary[0].evidence).not.toContain("Unselected third evidence");
  });
});

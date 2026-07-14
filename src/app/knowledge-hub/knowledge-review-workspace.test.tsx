// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { ProjectKnowledgeDraftBlocker, ProjectKnowledgeReviewSummary } from "@/modules/rag/project-knowledge-review.contracts";
import { projectKnowledgeEntryInstances } from "@/modules/rag/project-knowledge-review.contracts";
import { KnowledgeReviewWorkspace } from "./knowledge-review-workspace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    entryInstanceId: `module-instance-${index}`,
    sourceWorkItemIds: [String(42 + index)],
    message: "This entry needs an immutable evidence reference.",
  };
}

function summary(blockers: ProjectKnowledgeDraftBlocker[]): ProjectKnowledgeReviewSummary {
  return {
    attemptedEvidenceRepairs: blockers.length + 2,
    automaticEvidenceRepairs: 2,
    automaticDuplicateConsolidations: 0,
    wordingCarryOvers: 0,
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
    entryInstanceId: "promo-code-conflict-instance",
    type: "hard_conflict",
    category: "hard_conflict",
    affectedCategory: "glossary",
    entryKey: "promo-code-conflict",
    identityKey: "promo-code-conflict",
    subject: "identity:glossary:promo code",
    conflictType: "duplicate_identity",
    participants: [participant("one", firstEntry), participant("two", secondEntry)],
    evidenceIdentical: false,
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

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("Showing 11-12 of 12")).toBeTruthy();
  });

  it("does not render a raw JSON editing surface", () => {
    renderWorkspace();
    expect(screen.queryByText(/Advanced JSON/)).toBeNull();
    expect(screen.queryByLabelText("Complete reviewed proposal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply edited JSON" })).toBeNull();
  });

  it("adds an exact reviewer reference from immutable source text before validation", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      onResolve,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [{
          category: "module",
          entryKey: "checkout",
          entryInstanceId: "module-instance-0",
          sourceAvailability: "available",
          affectedWorkItemIds: ["42"],
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

  it("targets one duplicate logical entry by entryInstanceId", async () => {
    const duplicateKnowledge: ProjectKnowledgeBase = {
      ...knowledge,
      glossary: [
        {
          term: "payment gateway",
          type: "term",
          definition: "The first definition.",
          sourceWorkItemIds: ["41"],
          evidence: "First evidence.",
          evidenceRefs: [],
        },
        {
          term: "payment gateway",
          type: "term",
          definition: "The retained second definition.",
          sourceWorkItemIds: ["42"],
          evidence: "Second evidence.",
          evidenceRefs: [],
        },
      ],
    };
    const instances = projectKnowledgeEntryInstances(duplicateKnowledge)
      .filter((instance) => instance.category === "glossary");
    const target = instances[1];
    const blocker: ProjectKnowledgeDraftBlocker = {
      id: "duplicate-glossary-evidence",
      type: "missing_evidence_refs",
      category: "glossary",
      entryKey: "payment gateway",
      entryInstanceId: target.entryInstanceId,
      sourceWorkItemIds: ["42"],
      message: "This entry needs an immutable evidence reference.",
    };
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      blockers: [blocker],
      proposedKnowledge: duplicateKnowledge,
      reviewSummary: {
        ...summary([blocker]),
        byCategory: { glossary: 1 },
      },
      onResolve,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [{
          category: "glossary",
          entryKey: "payment gateway",
          entryInstanceId: target.entryInstanceId,
          sourceAvailability: "available",
          affectedWorkItemIds: ["42"],
          sources: [{
            sourceSnapshotId: "snapshot-42",
            sourceWorkItemId: "42",
            workItemType: "User Story",
            workItemTitle: "Payment gateway",
            workItemUrl: "https://dev.azure.com/acme/shop/_workitems/edit/42",
            adoRevision: 4,
            sourceUpdatedAt: "2026-07-12T10:00:00.000Z",
            capturedAt: "2026-07-12T10:05:00.000Z",
            fields: [{ sourceField: "description", text: "Second evidence." }],
          }],
        }],
        sources: [],
      }),
    });

    expect((await screen.findByText(/Current evidence:/)).parentElement).toHaveTextContent("Second evidence.");
    fireEvent.click(screen.getByRole("button", { name: "Use entire field" }));
    fireEvent.click(screen.getByRole("button", { name: "Add evidence reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Validate review changes" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].glossary[0].evidenceRefs).toEqual([]);
    expect(onResolve.mock.calls[0][0].glossary[1].evidenceRefs).toEqual([
      expect.objectContaining({ sourceWorkItemId: "42", quote: "Second evidence." }),
    ]);
  });

  it("explains an unavailable source snapshot and offers safe regeneration", async () => {
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      onRegenerate,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [{
          category: "module",
          entryKey: "checkout",
          entryInstanceId: "module-instance-0",
          sourceAvailability: "snapshot_missing",
          affectedWorkItemIds: ["42"],
          sources: [],
        }],
        sources: [],
      }),
    });

    expect(await screen.findByText("Source snapshot unavailable for Work Item 42. This entry cannot be verified in the current draft.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources and regenerate draft" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources and regenerate" }));
    await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1));
  });

  it("renders legacy blocker ID collisions without a React key warning", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = missingBlocker(0);
    const second = { ...missingBlocker(1), id: first.id, entryKey: "checkout" };
    renderWorkspace({ blockers: [first, second], reviewSummary: summary([first, second]) });

    await waitFor(() => expect(screen.getAllByText("Evidence link required")).toHaveLength(2));
    const keyWarnings = consoleError.mock.calls.filter((call) =>
      call.some((value) => String(value).includes("same key") || String(value).includes("unique \"key\"")));
    expect(keyWarnings).toHaveLength(0);
    consoleError.mockRestore();
  });

  it("applies a structured replay choice without exposing raw JSON", () => {
    const replay: ProjectKnowledgeDraftBlocker = {
      id: "replay-1",
      type: "replay_conflict",
      category: "module",
      entryKey: "checkout",
      entryInstanceId: "checkout-replay-instance",
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
      entryInstanceId: "hard-conflict-instance-1",
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
      evidenceIdentical: false,
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

    const versionOneButton = screen.getByRole("button", { name: "Keep version 1" });
    const versionTwoButton = screen.getByRole("button", { name: "Keep version 2" });
    expect(screen.queryByText("Same source evidence")).toBeNull();
    fireEvent.click(versionTwoButton);
    expect(screen.getByText("Version 2 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Version 2 selected" })).toHaveAttribute("aria-pressed", "true");
    expect(versionOneButton).toHaveAttribute("aria-pressed", "false");
    expect(versionOneButton.closest("fieldset")?.className).not.toContain("opacity");
    expect(screen.getByText("A code entered during checkout.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save decisions and re-check" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].glossary).toEqual([expect.objectContaining({
      term: "promo code",
      type: "business_entity",
      definition: "A discount token issued by Marketing.",
    })]);
  });

  it("replaces logical identity aliases without removing unrelated Unicode entries", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Review and combine" }));
    const previewButton = screen.getByRole("button", { name: "Preview combined entry" });
    expect(previewButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save decisions and re-check" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Choose source version for Type"), { target: { value: "0" } });
    expect(previewButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Choose source version for Definition"), { target: { value: "1" } });
    expect(previewButton).not.toBeDisabled();
    fireEvent.click(previewButton);
    expect(screen.getByText("Combined entry preview")).toBeTruthy();
    expect(screen.getByText("From Version 1")).toBeTruthy();
    expect(screen.getByText("From Version 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save decisions and re-check" })).toBeDisabled();
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use combined entry" }));
    expect(screen.getByText("Entries combined")).toBeTruthy();
    expect(screen.getByText("Selected final result")).toBeTruthy();
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

  it("labels evidence-identical conflicts and keeps the decision buttons", () => {
    const { firstEntry, secondEntry, conflict } = glossaryConflictFixture();
    renderWorkspace({
      blockers: [{ ...conflict, evidenceIdentical: true }],
      proposedKnowledge: { ...knowledge, glossary: [firstEntry, secondEntry] },
      reviewSummary: {
        ...summary([]),
        remainingBlockers: 1,
        byType: { hard_conflict: 1 },
        byCategory: { glossary: 1 },
      },
    });

    expect(screen.getByText("Same source evidence")).toBeTruthy();
    expect(screen.getByText(/differ only in wording/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep version 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep version 2" })).toBeTruthy();
  });

  it("removes an unpublishable entry from the draft with a guided action", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      onResolve,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [{
          category: "module",
          entryKey: "checkout",
          entryInstanceId: "module-instance-0",
          sourceAvailability: "snapshot_missing",
          affectedWorkItemIds: ["42"],
          sources: [],
        }],
        sources: [],
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remove entry from draft" }));
    expect(screen.getByText(/Entry removed from draft — pending re-check/)).toBeTruthy();
    expect(screen.getByText("1 decided locally — re-check to apply")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Validate review changes" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].modules).toEqual([]);
  });

  it("accepts server-suggested evidence with one click", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      onResolve,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [{
          category: "module",
          entryKey: "checkout",
          entryInstanceId: "module-instance-0",
          sourceAvailability: "snapshot_missing",
          affectedWorkItemIds: ["42"],
          sources: [],
          suggestedEvidence: [{
            sourceSnapshotId: "snapshot-88",
            sourceWorkItemId: "8",
            sourceField: "acceptanceCriteria",
            quote: "Customers complete checkout securely.",
            verification: "exact",
          }],
        }],
        sources: [],
      }),
    });

    expect(await screen.findByText("Suggested evidence found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept suggested evidence" }));
    expect(screen.getByText(/Suggested evidence accepted — pending re-check/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Validate review changes" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].modules[0].evidenceRefs).toEqual([expect.objectContaining({
      sourceSnapshotId: "snapshot-88",
      sourceWorkItemId: "8",
      sourceField: "acceptanceCriteria",
      quote: "Customers complete checkout securely.",
      origin: "reviewer_reanchored",
      verification: "exact",
    })]);
  });

  it("bulk-removes entries that cannot be verified against any captured source", async () => {
    const first = missingBlocker(0);
    const second = { ...missingBlocker(1), entryKey: "returns", entryInstanceId: "module-instance-1" };
    const extendedKnowledge = {
      ...knowledge,
      modules: [
        ...knowledge.modules,
        {
          id: "returns",
          name: "Returns",
          description: "Customers return items.",
          sourceWorkItemIds: ["43"],
          evidence: "Customers return items for refunds.",
        },
      ],
    };
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      blockers: [first, second],
      proposedKnowledge: extendedKnowledge,
      reviewSummary: summary([first, second]),
      onResolve,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [
          {
            category: "module",
            entryKey: "checkout",
            entryInstanceId: "module-instance-0",
            sourceAvailability: "snapshot_missing",
            affectedWorkItemIds: ["42"],
            sources: [],
          },
          {
            category: "module",
            entryKey: "returns",
            entryInstanceId: "module-instance-1",
            sourceAvailability: "snapshot_missing",
            affectedWorkItemIds: ["43"],
            sources: [],
          },
        ],
        sources: [],
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remove 2 unverifiable entries" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove entries" }));
    expect(screen.getByText("2 decided locally — re-check to apply")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Validate review changes" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].modules).toEqual([]);
  });

  it("counts and removes per entry when several blockers cite the same entry", async () => {
    const first = missingBlocker(0);
    const second = { ...missingBlocker(1), entryKey: "checkout", entryInstanceId: "module-instance-0" };
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      blockers: [first, second],
      reviewSummary: summary([first, second]),
      onResolve,
      onLoadReviewContext: vi.fn().mockResolvedValue({
        entries: [{
          category: "module",
          entryKey: "checkout",
          entryInstanceId: "module-instance-0",
          sourceAvailability: "snapshot_missing",
          affectedWorkItemIds: ["42"],
          sources: [],
        }],
        sources: [],
      }),
    });

    // One underlying entry — the bulk action counts entries, not blockers.
    fireEvent.click(await screen.findByRole("button", { name: "Remove 1 unverifiable entry" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove entries" }));
    // Both sibling blocker cards show the decision instead of a dead-end warning.
    expect(screen.getAllByText(/Entry removed from draft — pending re-check/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Validate review changes" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0].modules).toEqual([]);
  });
});

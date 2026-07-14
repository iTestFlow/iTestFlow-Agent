// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendUniqueContextItems,
  changedKnowledgeEntryIdentities,
  IndexedContextView,
  KnowledgeCandidatesView,
  KnowledgeExplorer,
  KnowledgeOpsPanel,
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

function knowledgeBaseWithModules(count: number) {
  return {
    modules: Array.from({ length: count }, (_, index) => ({
      id: `module-${index + 1}`,
      name: `Module ${index + 1}`,
      description: `Description for module ${index + 1}`,
      evidence: `Evidence for module ${index + 1}`,
      sourceWorkItemIds: [`${index + 1}`],
    })),
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  };
}

function contextItem(id: string, title = `Work item ${id}`) {
  return {
    workItemId: id,
    workItemType: "User Story",
    title,
    state: "Active",
    syncStatus: "active",
    updatedDate: "2026-07-13T10:00:00.000Z",
    lastIndexedAt: "2026-07-13T10:00:00.000Z",
    chunkCount: 2,
  };
}

function knowledgeOpsProps(onReportMiss = vi.fn().mockResolvedValue(true)) {
  return {
    lint: null,
    logItems: [],
    logVisible: false,
    exportResult: null,
    healthLoading: false,
    logLoading: false,
    exportLoading: false,
    reportLoading: false,
    canManage: true,
    onRunHealthCheck: vi.fn(),
    onToggleLog: vi.fn(),
    onExport: vi.fn(),
    onReportMiss,
    onTransitionIssue: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Knowledge Hub candidates UI", () => {
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
});

describe("Knowledge Hub missed-issue report", () => {
  it("starts collapsed, supports keyboard expansion, and resets after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<KnowledgeOpsPanel {...knowledgeOpsProps()} />);
    const trigger = screen.getByRole("button", { name: /Report a missed duplicate or conflict/i });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    unmount();
    render(<KnowledgeOpsPanel {...knowledgeOpsProps()} />);
    expect(screen.getByRole("button", { name: /Report a missed duplicate or conflict/i }).getAttribute("aria-expanded")).toBe("false");
  });

  it("clears the form and announces a successful report", async () => {
    const onReportMiss = vi.fn().mockResolvedValue(true);
    render(<KnowledgeOpsPanel {...knowledgeOpsProps(onReportMiss)} />);
    fireEvent.click(screen.getByRole("button", { name: /Report a missed duplicate or conflict/i }));

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Repeated checkout rule" } });
    fireEvent.change(screen.getByLabelText("Evidence and impact"), { target: { value: "Rules 10 and 11 contain the same constraint." } });
    fireEvent.click(screen.getByRole("button", { name: "Report miss" }));

    await waitFor(() => expect(onReportMiss).toHaveBeenCalledWith({
      missType: "duplicate",
      title: "Repeated checkout rule",
      message: "Rules 10 and 11 contain the same constraint.",
    }));
    expect(await screen.findByText("Report submitted for review.")).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Evidence and impact") as HTMLTextAreaElement).value).toBe("");
  });

  it("preserves report details when submission fails", async () => {
    const onReportMiss = vi.fn().mockResolvedValue(false);
    render(<KnowledgeOpsPanel {...knowledgeOpsProps(onReportMiss)} />);
    fireEvent.click(screen.getByRole("button", { name: /Report a missed duplicate or conflict/i }));

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Conflicting limits" } });
    fireEvent.change(screen.getByLabelText("Evidence and impact"), { target: { value: "Rules 20 and 21 disagree." } });
    fireEvent.click(screen.getByRole("button", { name: "Report miss" }));

    await waitFor(() => expect(onReportMiss).toHaveBeenCalled());
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Conflicting limits");
    expect((screen.getByLabelText("Evidence and impact") as HTMLTextAreaElement).value).toBe("Rules 20 and 21 disagree.");
    expect(screen.queryByText("Report submitted for review.")).toBeNull();
  });
});

describe("Knowledge Explorer scrolling", () => {
  it("renders every main-view match without pagination and resets scroll after filtering", () => {
    render(<KnowledgeExplorer knowledgeBase={knowledgeBaseWithModules(8)} />);

    expect(screen.getByText("Module 1")).toBeTruthy();
    expect(screen.getByText("Module 8")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

    const results = screen.getByRole("region", { name: "Scrollable knowledge explorer results" });
    results.scrollTop = 140;
    fireEvent.click(screen.getByRole("button", { name: /Modules\s*8/i }));
    expect(results.scrollTop).toBe(0);
  });

  it("keeps five-item pagination and highlighted-entry navigation in compact previews", async () => {
    const base = knowledgeBaseWithModules(6);
    const updated = {
      ...base,
      modules: base.modules.map((module, index) => index === 5
        ? { ...module, description: "Updated sixth module" }
        : module),
    };
    const highlighted = changedKnowledgeEntryIdentities(base, updated);

    render(<KnowledgeExplorer knowledgeBase={updated} compact highlightedEntryIdentities={highlighted} />);

    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(await screen.findByText("Module 6")).toBeTruthy();
    expect(screen.getByText("Updated review result")).toBeTruthy();
  });
});

describe("Indexed Project Context progressive loading", () => {
  const baseProps = {
    items: [contextItem("101"), contextItem("102")],
    totalCount: 3,
    sortBy: "lastIndexedAt" as const,
    sortDirection: "desc" as const,
    search: "",
    loading: false,
    loadingMore: false,
    hasMore: true,
    error: null,
    emptyMessage: "No indexed project context.",
    onSearchChange: vi.fn(),
    onSortChange: vi.fn(),
    onLoadMore: vi.fn(),
  };

  it("requests the next batch, exposes loading, and announces completion", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<IndexedContextView {...baseProps} onLoadMore={onLoadMore} />);

    expect(screen.getByText(/Showing 2 of 3 active source work items/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Load more indexed project context/ }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<IndexedContextView {...baseProps} onLoadMore={onLoadMore} loadingMore />);
    expect((screen.getByRole("button", { name: /Load more indexed project context/ }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<IndexedContextView
      {...baseProps}
      onLoadMore={onLoadMore}
      items={[...baseProps.items, contextItem("103")]}
      hasMore={false}
    />);
    expect(screen.getByText("All 3 active source work items loaded")).toBeTruthy();
  });

  it("resets the scroll region when search changes", () => {
    const { rerender } = render(<IndexedContextView {...baseProps} />);
    const region = screen.getByRole("region", { name: "Scrollable indexed project context" });
    region.scrollTop = 160;

    rerender(<IndexedContextView {...baseProps} search="checkout" />);
    expect(region.scrollTop).toBe(0);
  });

  it("appends overlapping batches without duplicate work items", () => {
    const appended = appendUniqueContextItems(
      [contextItem("101"), contextItem("102", "Old title")],
      [contextItem("102", "Updated title"), contextItem("103")],
    );

    expect(appended.map((item) => item.workItemId)).toEqual(["101", "102", "103"]);
    expect(appended[1]?.title).toBe("Updated title");
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

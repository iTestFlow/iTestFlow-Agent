// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendUniqueContextItems,
  IndexSummary,
  IndexedContextView,
  KnowledgeCandidatesView,
  KnowledgeExplorer,
  KnowledgeExportControls,
} from "./knowledge-hub-client";

afterEach(cleanup);

describe("Knowledge Hub project indexing summary", () => {
  it("shows the original source synchronization metrics", () => {
    render(<IndexSummary result={{
      mode: "incremental",
      fetchedCount: 87,
      storedWorkItemCount: 84,
      indexedWorkItemCount: 12,
      indexedChunkCount: 48,
      createdCount: 3,
      updatedCount: 9,
      unchangedCount: 72,
      inactiveCount: 3,
      skippedEmptyCount: 1,
      workItemTypes: ["Feature", "User Story"],
      states: ["Active"],
    }} />);

    expect(screen.getByText("Latest Indexing Summary")).toBeTruthy();
    for (const label of ["Fetched", "New", "Updated", "Unchanged", "Inactive", "Reindexed", "Chunks indexed", "Skipped empty"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

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

function publishedKnowledgeBaseWithEvidence() {
  return {
    modules: [{
      id: "mod-private-checkout",
      name: "Published Checkout",
      description: "Coordinates checkout processing.",
      evidence: "Legacy checkout evidence.",
      sourceWorkItemIds: ["98765"],
      evidenceRefs: [{
        sourceSnapshotId: "snapshot-98765",
        sourceWorkItemId: "98765",
        sourceField: "iterationPath" as const,
        quote: "Sponsor confirms the identity document before checkout.",
        origin: "generated_v4" as const,
        verification: "exact" as const,
      }],
    }, {
      id: "module-secondary",
      name: "Secondary Module",
      description: "A separate published module.",
      evidence: "Legacy-only secondary evidence.",
      sourceWorkItemIds: ["200"],
    }],
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
    expect(screen.queryByRole("button", { name: "Integrate" })).toBeNull();
  });

  it("lets owners filter and integrate a candidate", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Integrate" }));

    expect(onStatusChange).toHaveBeenCalledWith("grounded");
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("candidate-1", "request_integration"));
  });

  it("offers integration for an ungrounded candidate", () => {
    // A saved chatbot answer is stored ungrounded and can never become grounded, since
    // grounding requires every fragment to re-anchor to an immutable snapshot quote and
    // a synthesis is not a quote. Gating the action on grounded made it unreachable for
    // the only content that ever arrives here.
    render(<KnowledgeCandidatesView
      candidates={[{ ...candidate, status: "legacy_ungrounded" as const }]}
      status="all"
      loading={false}
      canManage
      onStatusChange={vi.fn()}
      onAction={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Integrate" })).toBeTruthy();
  });

  it("offers integration for a legacy integration_requested candidate", () => {
    // Rows in this status predate direct integration: the old flow only recorded a
    // request nothing fulfilled. The API accepts integrating them (only rejected is
    // barred), so hiding the buttons stranded them permanently.
    render(<KnowledgeCandidatesView
      candidates={[{ ...candidate, status: "integration_requested" as const }]}
      status="all"
      loading={false}
      canManage
      onStatusChange={vi.fn()}
      onAction={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Integrate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("stops offering integration once a candidate is integrated", () => {
    render(<KnowledgeCandidatesView
      candidates={[{ ...candidate, status: "integrated" as const }]}
      status="all"
      loading={false}
      canManage
      onStatusChange={vi.fn()}
      onAction={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: "Integrate" })).toBeNull();
  });
});

describe("Knowledge Hub export controls", () => {
  it("lets managers export and shows the result banner", () => {
    const onExport = vi.fn();
    render(<KnowledgeExportControls
      exportResult={{ exportRoot: "C:\\wiki\\proj", fileCount: 12 }}
      exportLoading={false}
      canManage
      onExport={onExport}
    />);

    fireEvent.click(screen.getByRole("button", { name: /export files/i }));
    expect(onExport).toHaveBeenCalled();
    expect(screen.getByText(/Exported 12 knowledge files to/)).toBeTruthy();
    expect(screen.getByText("C:\\wiki\\proj")).toBeTruthy();
  });

  it("renders nothing for members", () => {
    const { container } = render(<KnowledgeExportControls
      exportResult={null}
      exportLoading={false}
      canManage={false}
      onExport={vi.fn()}
    />);

    expect(container.innerHTML).toBe("");
  });

  it("disables the button while an export is running", () => {
    render(<KnowledgeExportControls
      exportResult={null}
      exportLoading
      canManage
      onExport={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: /export files/i })).toHaveProperty("disabled", true);
  });
});

describe("Knowledge Explorer scrolling", () => {
  it("renders every main-view match without pagination and resets scroll after filtering", () => {
    render(<KnowledgeExplorer knowledgeBase={knowledgeBaseWithModules(8)} />);

    expect(screen.getByText("Module 1")).toBeTruthy();
    expect(screen.getByText("Module 8")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

    const results = screen.getByRole("region", { name: "Scrollable knowledge explorer results" });
    const categoryGroup = screen.getByRole("group", { name: "Knowledge categories" });
    const expectedCategories = [
      ["All", 8, "all"],
      ["Modules", 8, "module"],
      ["Business Rules", 0, "businessRule"],
      ["State Transitions", 0, "stateTransition"],
      ["Glossary", 0, "glossary"],
      ["Dependencies", 0, "dependency"],
    ] as const;

    for (const [label, count, iconKey] of expectedCategories) {
      const button = within(categoryGroup).getByRole("button", { name: new RegExp(`${label}\\s*${count}`, "i") });
      const icon = button.querySelector(`svg[data-knowledge-category-icon="${iconKey}"]`);
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
    }

    const allButton = within(categoryGroup).getByRole("button", { name: /All\s*8/i });
    const modulesButton = within(categoryGroup).getByRole("button", { name: /Modules\s*8/i });
    expect(allButton).toHaveAttribute("aria-pressed", "true");
    expect(modulesButton).toHaveAttribute("aria-pressed", "false");
    expect(categoryGroup).toHaveClass("min-w-0", "max-w-full");
    expect(results).toHaveClass("min-w-0", "max-w-full", "overflow-x-clip");
    expect(results.parentElement).toHaveClass("grid-cols-[minmax(0,1fr)]", "lg:grid-cols-[216px_minmax(0,1fr)]");

    results.scrollTop = 140;
    fireEvent.click(modulesButton);
    expect(results.scrollTop).toBe(0);
    expect(allButton).toHaveAttribute("aria-pressed", "false");
    expect(modulesButton).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps five-item pagination and highlighted-entry navigation in compact previews", async () => {
    const base = knowledgeBaseWithModules(6);
    const updated = {
      ...base,
      modules: base.modules.map((module, index) => index === 5
        ? { ...module, description: "Updated sixth module" }
        : module),
    };
    const highlighted = [`modules:${JSON.stringify(updated.modules[5])}`];

    render(<KnowledgeExplorer knowledgeBase={updated} compact highlightedEntryIdentities={highlighted} />);

    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(await screen.findByText("Module 6")).toBeTruthy();
    expect(screen.getByText("Updated review result")).toBeTruthy();
    const results = screen.getByRole("region", { name: "Scrollable knowledge preview" });
    expect(results).toHaveClass("min-w-0", "max-w-full", "overflow-x-clip");
    expect(results.parentElement).toHaveClass("grid-cols-[minmax(0,1fr)]");
  });

  it("shows the published entry fields and verified evidence through the shared details disclosure", () => {
    render(<KnowledgeExplorer knowledgeBase={publishedKnowledgeBaseWithEvidence()} />);

    fireEvent.click(screen.getByRole("button", { name: "Show details for Published Checkout" }));

    expect(screen.getByText("mod-private-checkout")).toBeTruthy();
    expect(screen.getByText(/Sponsor confirms the identity document before checkout\./)).toBeTruthy();
    expect(screen.getAllByText("#98765").length).toBeGreaterThan(0);
  });

  it("searches published structured fields, evidence metadata, quotes, and source IDs", async () => {
    render(<KnowledgeExplorer knowledgeBase={publishedKnowledgeBaseWithEvidence()} />);
    const search = screen.getByRole("textbox", { name: "Search compiled knowledge" });

    for (const query of [
      "mod-private-checkout",
      "iterationPath",
      "identity document",
      "98765",
    ]) {
      fireEvent.change(search, { target: { value: query } });
      await waitFor(() => {
        expect(screen.getByText("1 entries match the current filters.")).toBeTruthy();
        expect(screen.queryByText("Secondary Module")).toBeNull();
      });
    }

    fireEvent.change(search, { target: { value: "Legacy-only secondary evidence" } });
    await waitFor(() => {
      expect(screen.getByText("1 entries match the current filters.")).toBeTruthy();
      expect(screen.queryByText("Published Checkout")).toBeNull();
    });
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

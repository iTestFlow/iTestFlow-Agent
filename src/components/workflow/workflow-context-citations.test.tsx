// @vitest-environment jsdom

import { useRef, useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowContextCitation } from "@/modules/rag/workflow-context-citations";
import { WorkflowContextCitations } from "./workflow-context-citations";

const citations: WorkflowContextCitation[] = [
  {
    sourceType: "project_context",
    sourceId: "WI:340226",
    title: "Checkout feature",
    reason: "Linked to this story.",
    workItemId: "340226",
    workItemType: "Feature",
  },
  {
    sourceType: "project_knowledge",
    sourceId: "KB:business_rule:payment-approval",
    title: "Payment needs approval",
    reason: "Derived from related story WI:340226.",
    category: "business_rule",
    sourceWorkItemIds: ["340226"],
  },
];

function ReviewHarness() {
  const [open, setOpen] = useState(false);
  const [excludedSourceIds, setExcludedSourceIds] = useState<string[]>([]);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button ref={openerRef} type="button" onClick={() => setOpen(true)}>
        Review context
      </button>
      <WorkflowContextCitations
        citations={citations}
        editable
        excludedSourceIds={excludedSourceIds}
        onExcludedSourceIdsChange={setExcludedSourceIds}
        open={open}
        onOpenChange={setOpen}
        restoreFocusRef={openerRef}
        hideSummary
      />
    </>
  );
}

describe("WorkflowContextCitations", () => {
  afterEach(cleanup);

  it("uses the knowledge topic for older citations without a reason", () => {
    render(<WorkflowContextCitations
      citations={[
        {
          sourceType: "project_knowledge",
          sourceId: "KB:module:catalog",
          title: "Product Discovery & Catalog Browsing",
          category: "module",
          sourceWorkItemIds: ["2"],
        },
        {
          sourceType: "project_knowledge",
          sourceId: "KB:module:long",
          title: "😀".repeat(160),
          category: "module",
          sourceWorkItemIds: ["3"],
        },
      ]}
      open
      onOpenChange={() => undefined}
      hideSummary
    />);

    expect(screen.getByText("Adds module context about Product Discovery & Catalog Browsing.")).toBeInTheDocument();
    expect(screen.queryByText(/Derived from related story/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Adds module context about 😀/).textContent?.replace(/^Reason: /, "").length)
      .toBeLessThanOrEqual(160);
  });

  it("shows concise reasons, removes/restores dependent context, and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(<ReviewHarness />);

    const opener = screen.getByRole("button", { name: "Review context" });
    await user.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "All Context References" });
    expect(dialog).toHaveTextContent("2 included, 0 excluded");
    expect(screen.getByText("Linked to this story.")).toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const initialDialogButtons = within(dialog).getAllByRole("button");
    initialDialogButtons.at(-1)?.focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const removeStory = screen.getByRole("button", { name: "Remove Checkout feature from context" });
    removeStory.focus();
    await user.keyboard("{Enter}");

    expect(dialog).toHaveTextContent("0 included, 2 excluded");
    expect(screen.getByText("Excluded because source WI:340226 was removed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore Payment needs approval from context" })).toBeDisabled();

    const restoreStory = screen.getByRole("button", { name: "Restore Checkout feature from context" });
    restoreStory.focus();
    await user.keyboard("{Enter}");
    expect(dialog).toHaveTextContent("2 included, 0 excluded");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "All Context References" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequirementFinding } from "./test-intelligence-types";
import { RequirementFindingsReview } from "./requirement-findings-review";

function finding(overrides: Partial<RequirementFinding> = {}): RequirementFinding {
  return {
    id: "RF-001",
    checklistItemId: "completeness_testability",
    issueType: "missing_requirement",
    severity: "critical",
    title: "Payment failure is unspecified",
    description: "The requirement omits declined-payment behavior.",
    suggestion: "Define a declined-payment outcome.",
    riskLevel: "high",
    riskJustification: "Orders can become inconsistent.",
    affectedAreas: ["Checkout"],
    references: [],
    contradiction: false,
    ...overrides,
  };
}

const findings = [
  finding(),
  finding({
    id: "RF-002",
    issueType: "ambiguity",
    severity: "low",
    title: "Timeout wording is ambiguous",
    riskLevel: "low",
  }),
];

describe("RequirementFindingsReview", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(cleanup);

  it("filters findings by search and severity", () => {
    render(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search requirement findings" }), {
      target: { value: "timeout" },
    });
    expect(screen.getByText("Timeout wording is ambiguous")).toBeInTheDocument();
    expect(screen.queryByText("Payment failure is unspecified")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search requirement findings" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter findings by severity" }), {
      target: { value: "critical" },
    });
    expect(screen.getByText("Payment failure is unspecified")).toBeInTheDocument();
    expect(screen.queryByText("Timeout wording is ambiguous")).not.toBeInTheDocument();
  });

  it("selects only the currently visible findings", () => {
    const onSelectedIdsChange = vi.fn();
    render(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Filter findings by risk" }), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible findings" }));
    expect(onSelectedIdsChange).toHaveBeenCalledWith(["RF-001"]);
  });

  it("toggles one finding through its accessible selection control", () => {
    const onSelectedIdsChange = vi.fn();
    render(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select RF-002" }));
    expect(onSelectedIdsChange).toHaveBeenCalledWith(["RF-002"]);
  });

  it("trims editable text fields before returning the saved finding", () => {
    const onChange = vi.fn();
    render(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={["RF-001"]}
        onChange={onChange}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByDisplayValue("Payment failure is unspecified"), {
      target: { value: "  Payment decline behavior is unspecified  " },
    });
    fireEvent.change(screen.getByDisplayValue("The requirement omits declined-payment behavior."), {
      target: { value: "  Missing declined-payment behavior.  " },
    });
    fireEvent.change(screen.getByDisplayValue("Define a declined-payment outcome."), {
      target: { value: "  Define the declined-payment outcome.  " },
    });
    fireEvent.change(screen.getByDisplayValue("Orders can become inconsistent."), {
      target: { value: "  Orders can become inconsistent after failure.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        id: "RF-001",
        title: "Payment decline behavior is unspecified",
        description: "Missing declined-payment behavior.",
        suggestion: "Define the declined-payment outcome.",
        riskJustification: "Orders can become inconsistent after failure.",
      }),
      findings[1],
    ]);
  });

  it("prunes edited state when a finding disappears from props", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={["RF-001"]}
        onChange={onChange}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    rerender(
      <RequirementFindingsReview
        findings={[findings[1]]}
        selectedIds={[]}
        onChange={onChange}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    rerender(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={[]}
        onChange={onChange}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Edited only" }));

    expect(screen.getByText("No findings match the current filters.")).toBeInTheDocument();
    expect(screen.queryByText("Payment failure is unspecified")).not.toBeInTheDocument();
  });

  it("removes selected findings only after confirmation and clears their selection", () => {
    const onChange = vi.fn();
    const onSelectedIdsChange = vi.fn();
    render(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={["RF-001"]}
        onChange={onChange}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove selected" }));
    expect(screen.getByRole("alertdialog", { name: "Remove selected findings?" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove findings" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([findings[1]]);
    expect(onSelectedIdsChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("renders caller-owned footer content", () => {
    render(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
        footer={<button type="button">Publish selected findings</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Publish selected findings" })).toBeInTheDocument();
  });

  it("distinguishes no findings from a filtered empty state", () => {
    const { rerender } = render(
      <RequirementFindingsReview
        findings={[]}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("No requirement findings remain.")).toBeInTheDocument();

    rerender(
      <RequirementFindingsReview
        findings={findings}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search requirement findings" }), {
      target: { value: "not present" },
    });
    expect(screen.getByText("No findings match the current filters.")).toBeInTheDocument();
  });
});

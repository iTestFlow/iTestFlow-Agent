// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeneratedTestCase } from "./test-intelligence-types";
import { GeneratedTestCasesReview } from "./generated-test-cases-review";

function generatedCase(overrides: Partial<GeneratedTestCase> = {}): GeneratedTestCase {
  return {
    id: "TC-001",
    title: "Successful checkout",
    description: "Checkout succeeds with valid payment.",
    priority: 1,
    type: "functional",
    category: "Checkout",
    tags: ["regression"],
    preconditions: "Customer has a cart.",
    steps: [{ stepNumber: 1, action: "Submit payment", expectedResult: "Order is created" }],
    ...overrides,
  };
}

const cases = [
  generatedCase(),
  generatedCase({
    id: "TC-002",
    title: "Declined payment",
    priority: 2,
    type: "negative",
    tags: ["payments"],
  }),
];

describe("GeneratedTestCasesReview", () => {
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

  it("filters cases by observable search, type, priority, and tag controls", () => {
    render(
      <GeneratedTestCasesReview
        testCases={cases}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search generated test cases" }), {
      target: { value: "declined" },
    });
    expect(screen.getByText("Declined payment")).toBeInTheDocument();
    expect(screen.queryByText("Successful checkout")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search generated test cases" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by priority" }), {
      target: { value: "1" },
    });
    expect(screen.getByText("Successful checkout")).toBeInTheDocument();
    expect(screen.queryByText("Declined payment")).not.toBeInTheDocument();
  });

  it("selects all currently visible cases without changing case content", () => {
    const onSelectedIdsChange = vi.fn();
    const onChange = vi.fn();
    render(
      <GeneratedTestCasesReview
        testCases={cases}
        selectedIds={[]}
        onChange={onChange}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible test cases" }));
    expect(onSelectedIdsChange).toHaveBeenCalledWith(["TC-001", "TC-002"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds a selected manual draft with a collision-free ID", () => {
    const onChange = vi.fn();
    const onSelectedIdsChange = vi.fn();
    const withManual = [...cases, generatedCase({ id: "TC-MANUAL-002", title: "Existing manual case" })];
    render(
      <GeneratedTestCasesReview
        testCases={withManual}
        selectedIds={["TC-001"]}
        onChange={onChange}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Test Case" }));
    const nextCases = onChange.mock.calls[0][0] as GeneratedTestCase[];
    expect(nextCases).toHaveLength(4);
    // The counter continues past the highest existing TC-MANUAL number instead of reissuing it.
    expect(nextCases[3].id).toBe("TC-MANUAL-003");
    expect(onSelectedIdsChange).toHaveBeenCalledWith(["TC-001", "TC-MANUAL-003"]);
  });

  it("normalizes the edited case with a synthetic preconditions row and renumbered execution steps", () => {
    const onChange = vi.fn();
    render(
      <GeneratedTestCasesReview
        testCases={cases}
        selectedIds={["TC-001"]}
        onChange={onChange}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const nextCases = onChange.mock.calls[0][0] as GeneratedTestCase[];
    expect(nextCases[0].steps).toEqual([
      {
        stepNumber: 1,
        action: "Preconditions:\nCustomer has a cart.",
        expectedResult: "Preconditions are met",
      },
      {
        stepNumber: 2,
        action: "Submit payment",
        expectedResult: "Order is created",
      },
    ]);
  });

  it("removes selected cases only after confirmation and clears their selection", () => {
    const onChange = vi.fn();
    const onSelectedIdsChange = vi.fn();
    render(
      <GeneratedTestCasesReview
        testCases={cases}
        selectedIds={["TC-001"]}
        onChange={onChange}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove selected" }));
    expect(screen.getByRole("alertdialog", { name: "Remove selected test cases?" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove cases" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([cases[1]]);
    expect(onSelectedIdsChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("hides destructive and additive affordances when disabled", () => {
    render(
      <GeneratedTestCasesReview
        testCases={cases}
        selectedIds={["TC-001"]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
        allowAdd={false}
        allowDelete={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add Test Case" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete TC-001" })).not.toBeInTheDocument();
  });

  it("distinguishes an empty draft from an empty filtered result", () => {
    const { rerender } = render(
      <GeneratedTestCasesReview
        testCases={[]}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("No generated test cases yet.")).toBeInTheDocument();

    rerender(
      <GeneratedTestCasesReview
        testCases={cases}
        selectedIds={[]}
        onChange={vi.fn()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search generated test cases" }), {
      target: { value: "not present" },
    });
    expect(screen.getByText("No test cases match the current filters.")).toBeInTheDocument();
  });
});

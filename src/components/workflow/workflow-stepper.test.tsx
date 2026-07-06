// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowStepper } from "./workflow-stepper";

const steps = [
  { id: "select", label: "Select source", description: "Choose a source suite." },
  { id: "review", label: "Review preview" },
  { id: "publish", label: "Publish changes" },
] as const;

describe("WorkflowStepper", () => {
  afterEach(cleanup);

  it("exposes current, completed, and locked states accessibly", () => {
    render(
      <WorkflowStepper
        steps={steps}
        activeStepId="review"
        completedStepIds={["select"]}
        enabledStepIds={["select"]}
        onStepChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", {
      name: "Review preview, step 2 of 3, current step",
    })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", {
      name: "Select source, step 1 of 3, completed",
    })).toBeEnabled();
    expect(screen.getByRole("button", {
      name: "Publish changes, step 3 of 3, locked",
    })).toBeDisabled();
  });

  it("navigates only through enabled steps", () => {
    const onStepChange = vi.fn();
    render(
      <WorkflowStepper
        steps={steps}
        activeStepId="review"
        enabledStepIds={["select"]}
        onStepChange={onStepChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", {
      name: "Select source, step 1 of 3, upcoming",
    }));
    expect(onStepChange).toHaveBeenCalledWith("select");
  });

  it("renders non-interactive status groups when no navigation callback exists", () => {
    render(<WorkflowStepper steps={steps} activeStepId="select" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("group", {
      name: "Select source, step 1 of 3, current step",
    })).toHaveAttribute("aria-current", "step");
  });

  it("uses the supplied navigation label", () => {
    render(
      <WorkflowStepper
        steps={steps}
        activeStepId="select"
        ariaLabel="Migration progress"
      />,
    );
    expect(screen.getByRole("navigation", { name: "Migration progress" })).toBeInTheDocument();
  });
});

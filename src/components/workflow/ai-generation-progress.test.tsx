// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiGenerationProgress } from "./ai-generation-progress";

describe("AiGenerationProgress", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("renders nothing for idle and completed runs without an open game", () => {
    const { container, rerender } = render(<AiGenerationProgress status="idle" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AiGenerationProgress status="completed" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces active progress and exposes cancellation only when allowed", () => {
    const onCancel = vi.fn();
    render(
      <AiGenerationProgress
        status="waiting_llm"
        elapsedSeconds={12}
        canCancel
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the AI response");
    expect(screen.getByText("Elapsed: 12s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("uses the shorter preparation flow and cancel label", () => {
    render(
      <AiGenerationProgress
        status="building_prompt"
        mode="prep"
        canCancel
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Preparing prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByText(/Please keep this page open/)).not.toBeInTheDocument();
  });

  it("renders a friendly failed state and retries", () => {
    const onRetry = vi.fn();
    render(
      <AiGenerationProgress
        status="failed"
        error={{ message: "network connection reset", code: "NETWORK" }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders cancellation recovery and moves focus to Try again", () => {
    const onRetry = vi.fn();
    render(<AiGenerationProgress status="cancelled" onRetry={onRetry} />);
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(screen.getByText("Generation was cancelled")).toBeInTheDocument();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

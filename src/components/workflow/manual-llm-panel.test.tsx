// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualLLMFields, ManualLLMPanel } from "./manual-llm-panel";

describe("ManualLLMPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => "{\"result\":true}"), writeText: vi.fn() },
    });
  });

  it("renders prompt metadata and the read-only prompt", () => {
    render(
      <ManualLLMPanel
        prompt="Run this prompt"
        promptVersion="v2"
        schemaName="TestCase"
        response=""
        onResponseChange={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    expect(screen.getByText("Prompt v2")).toBeInTheDocument();
    expect(screen.getByText("TestCase")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "External LLM prompt" })).toHaveValue("Run this prompt");
  });

  it("disables submission for empty, busy, or explicitly disabled input", () => {
    const props = {
      prompt: "Prompt",
      onResponseChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(
      <ManualLLMFields {...props} response=" " submitting={false} />,
    );
    expect(screen.getByRole("button", { name: "Validate External Result" })).toBeDisabled();

    rerender(<ManualLLMFields {...props} response="{}" submitting />);
    expect(screen.getByRole("button", { name: "Validating..." })).toBeDisabled();

    rerender(<ManualLLMFields {...props} response="{}" submitting={false} disabled />);
    expect(screen.getByRole("button", { name: "Validate External Result" })).toBeDisabled();
  });

  it("submits a non-empty response and reports edits", () => {
    const onResponseChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ManualLLMFields
        prompt="Prompt"
        response="{}"
        onResponseChange={onResponseChange}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "External LLM response" }), {
      target: { value: "{\"ok\":true}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate External Result" }));
    expect(onResponseChange).toHaveBeenCalledWith("{\"ok\":true}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("pastes the clipboard response through the controlled callback", async () => {
    const onResponseChange = vi.fn();
    render(
      <ManualLLMFields
        prompt="Prompt"
        response=""
        onResponseChange={onResponseChange}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Paste Response" }));
    await waitFor(() => {
      expect(onResponseChange).toHaveBeenCalledWith("{\"result\":true}");
    });
  });
});

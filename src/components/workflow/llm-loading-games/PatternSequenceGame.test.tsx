// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PatternSequenceGame } from "./PatternSequenceGame";

describe("PatternSequenceGame", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it("checks rapidly batched clicks against the latest input", () => {
    const onWin = vi.fn();
    render(<PatternSequenceGame modifierId="quick" onWin={onWin} />);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    const firstTile = screen.getByRole("button", {
      name: "Pattern tile row 1, column 1",
    });
    const secondTile = screen.getByRole("button", {
      name: "Pattern tile row 1, column 2",
    });
    const thirdTile = screen.getByRole("button", {
      name: "Pattern tile row 2, column 1",
    });
    const fourthTile = screen.getByRole("button", {
      name: "Pattern tile row 2, column 2",
    });

    act(() => {
      firstTile.click();
      secondTile.click();
      thirdTile.click();
      fourthTile.click();
      vi.advanceTimersByTime(0);
    });

    expect(screen.getByText("Pattern complete.")).toBeInTheDocument();
    expect(onWin).toHaveBeenCalledOnce();
  });

  it("resets the input cursor immediately after a wrong click", () => {
    render(<PatternSequenceGame modifierId="quick" />);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    const firstTile = screen.getByRole("button", {
      name: "Pattern tile row 1, column 1",
    });
    const wrongSecondTile = screen.getByRole("button", {
      name: "Pattern tile row 2, column 2",
    });

    act(() => {
      firstTile.click();
    });
    act(() => {
      wrongSecondTile.click();
      firstTile.click();
    });

    expect(screen.getByText("Repeat the pattern.")).toBeInTheDocument();
  });
});

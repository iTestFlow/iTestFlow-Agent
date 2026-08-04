// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNumberFlipDeck } from "./extra-game-utils";
import { NumberFlipGame } from "./NumberFlipGame";

function cardAt(position: number) {
  return screen.getByRole("button", { name: new RegExp(`^Card ${position},`) });
}

function cardPositions(count: number) {
  const deck = createNumberFlipDeck(count, 0);
  return {
    deck,
    forNumber: (number: number) => {
      const position = deck.indexOf(number);
      if (position < 0) throw new Error(`Number ${number} is missing from the deck.`);
      return position + 1;
    },
  };
}

describe("NumberFlipGame", () => {
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

  it("keeps every hidden-card accessible name limited to its board position", () => {
    render(<NumberFlipGame modifierId="quick-six" />);

    const cards = screen.getAllByRole("button", { name: /^Card \d+, hidden$/ });
    expect(cards).toHaveLength(6);
    cards.forEach((card, index) => {
      const position = index + 1;
      expect(card).toHaveAccessibleName(`Card ${position}, hidden`);
      expect(card.getAttribute("aria-label")?.replace(/^Card \d+, /, "")).toBe("hidden");
    });
  });

  it("keeps a correct number face up and advances to the following target", () => {
    const { forNumber } = cardPositions(6);
    render(<NumberFlipGame modifierId="quick-six" />);

    const onePosition = forNumber(1);
    act(() => {
      cardAt(onePosition).click();
    });

    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, correct`);
    expect(screen.getByText(/Next number: 2\./)).toBeInTheDocument();

    const twoPosition = forNumber(2);
    act(() => {
      cardAt(twoPosition).click();
    });

    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, correct`);
    expect(cardAt(twoPosition)).toHaveAccessibleName(`Card ${twoPosition}, number 2, correct`);
    expect(screen.getByText(/Next number: 3\./)).toBeInTheDocument();
  });

  it("locks after a mistake, resets after 550ms, and retains the original deck layout", () => {
    const { forNumber } = cardPositions(6);
    render(<NumberFlipGame modifierId="quick-six" />);

    const onePosition = forNumber(1);
    const twoPosition = forNumber(2);
    const wrongPosition = forNumber(3);

    act(() => {
      cardAt(onePosition).click();
      cardAt(wrongPosition).click();
      cardAt(twoPosition).click();
    });

    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, correct`);
    expect(cardAt(wrongPosition)).toHaveAccessibleName(`Card ${wrongPosition}, number 3, incorrect`);
    expect(cardAt(twoPosition)).toHaveAccessibleName(`Card ${twoPosition}, hidden`);

    act(() => {
      vi.advanceTimersByTime(549);
    });
    expect(cardAt(wrongPosition)).toHaveAccessibleName(`Card ${wrongPosition}, number 3, incorrect`);

    // Change the random source only after initialization: a reset must not build a new deck.
    vi.mocked(Math.random).mockReturnValue(0.9);
    act(() => {
      vi.advanceTimersByTime(1);
    });

    for (let position = 1; position <= 6; position += 1) {
      expect(cardAt(position)).toHaveAccessibleName(`Card ${position}, hidden`);
    }
    expect(screen.getByText(/Find 1\./)).toBeInTheDocument();

    act(() => {
      cardAt(onePosition).click();
    });
    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, correct`);
  });

  it("wins only once when every number is selected in ascending order, including rapid extra clicks", () => {
    const { deck, forNumber } = cardPositions(6);
    const onWin = vi.fn();
    render(<NumberFlipGame modifierId="quick-six" onWin={onWin} />);

    act(() => {
      for (const number of [...deck].sort((left, right) => left - right)) {
        cardAt(forNumber(number)).click();
      }
      cardAt(forNumber(1)).click();
      vi.advanceTimersByTime(0);
    });

    expect(onWin).toHaveBeenCalledOnce();

    act(() => {
      cardAt(forNumber(1)).click();
      vi.advanceTimersByTime(0);
    });
    expect(onWin).toHaveBeenCalledOnce();
  });

  it("does not accept interaction while disabled", () => {
    const { forNumber } = cardPositions(6);
    const onWin = vi.fn();
    render(<NumberFlipGame modifierId="quick-six" disabled onWin={onWin} />);

    const onePosition = forNumber(1);
    expect(cardAt(onePosition)).toBeDisabled();
    act(() => {
      cardAt(onePosition).click();
      vi.advanceTimersByTime(0);
    });

    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, hidden`);
    expect(screen.getByText(/Find 1\./)).toBeInTheDocument();
    expect(onWin).not.toHaveBeenCalled();
  });

  it("shows the preview board until the player explicitly hides it", () => {
    const { forNumber } = cardPositions(9);
    render(<NumberFlipGame modifierId="preview" />);

    const onePosition = forNumber(1);
    expect(screen.getAllByRole("button", { name: /^Card \d+, number \d+, revealed$/ })).toHaveLength(9);
    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, revealed`);
    expect(cardAt(onePosition)).toHaveAttribute("aria-pressed", "true");

    act(() => {
      cardAt(onePosition).click();
    });
    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, revealed`);

    act(() => {
      screen.getByRole("button", { name: "Hide cards and start" }).click();
    });
    expect(screen.queryByRole("button", { name: "Hide cards and start" })).not.toBeInTheDocument();
    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, hidden`);

    act(() => {
      cardAt(onePosition).click();
    });
    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, correct`);
  });

  it("allows one 900ms peek without hiding numbers that were correctly revealed", () => {
    const { forNumber } = cardPositions(9);
    render(<NumberFlipGame modifierId="peek" />);

    const onePosition = forNumber(1);
    const twoPosition = forNumber(2);
    act(() => {
      cardAt(onePosition).click();
    });
    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, correct`);

    act(() => {
      screen.getByRole("button", { name: "Peek once" }).click();
    });
    expect(cardAt(twoPosition)).toHaveAccessibleName(`Card ${twoPosition}, number 2, revealed`);
    expect(cardAt(twoPosition)).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Peek once" })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(899);
    });
    expect(cardAt(twoPosition)).toHaveAccessibleName(`Card ${twoPosition}, number 2, revealed`);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(cardAt(onePosition)).toHaveAccessibleName(`Card ${onePosition}, number 1, correct`);
    expect(cardAt(twoPosition)).toHaveAccessibleName(`Card ${twoPosition}, hidden`);
    expect(screen.getByText(/Next number: 2\./)).toBeInTheDocument();
  });

  it("clears a pending peek timer when unmounted", () => {
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<NumberFlipGame modifierId="peek" />);

    act(() => {
      screen.getByRole("button", { name: "Peek once" }).click();
    });
    unmount();

    expect(clearTimeout).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

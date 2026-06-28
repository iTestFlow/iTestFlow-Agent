import { describe, expect, it } from "vitest";

import {
  createMemoryDeck,
  createOddTilePuzzle,
  createPatternSequence,
  createSolvableLightsPuzzle,
  expectedPatternInput,
  isPatternInputCorrect,
  lightToggleIndices,
  oddTileCount,
  toggleLights,
  type OddTileModifier,
} from "./extra-game-utils";

describe("Memory Match", () => {
  it.each([4, 6, 8])("creates exactly two of every symbol for %i pairs", (pairCount) => {
    const deck = createMemoryDeck(pairCount, 2, () => 0.4);
    const counts = new Map<string, number>();
    deck.forEach((symbol) => counts.set(symbol, (counts.get(symbol) ?? 0) + 1));
    expect(deck).toHaveLength(pairCount * 2);
    expect(counts.size).toBe(pairCount);
    expect([...counts.values()].every((count) => count === 2)).toBe(true);
  });
});

describe("Lights Out", () => {
  it.each([
    [3, "orthogonal"],
    [4, "orthogonal"],
    [5, "orthogonal"],
    [4, "diagonal"],
    [4, "wrap"],
  ] as const)("creates a non-empty solvable %ix%i %s board", (size, mode) => {
    const puzzle = createSolvableLightsPuzzle(size, mode, 3, () => 0.37);
    const solved = puzzle.solutionMoves.reduce(
      (board, move) => toggleLights(board, size, move, mode),
      puzzle.board,
    );
    expect(puzzle.board.some(Boolean)).toBe(true);
    expect(solved.every((light) => !light)).toBe(true);
  });

  it("uses the intended neighbor rules", () => {
    const numeric = (left: number, right: number) => left - right;
    expect(lightToggleIndices(4, 5, "orthogonal").sort(numeric)).toEqual([1, 4, 5, 6, 9]);
    expect(lightToggleIndices(4, 5, "diagonal").sort(numeric)).toEqual([0, 2, 5, 8, 10]);
    expect(lightToggleIndices(4, 0, "wrap").sort(numeric)).toEqual([0, 1, 3, 4, 12]);
  });
});

describe("Find the Odd Tile", () => {
  it.each(["orientation", "count", "fill", "size", "offset"] as OddTileModifier[])(
    "creates exactly one %s difference",
    (modifier) => {
      const puzzle = createOddTilePuzzle(modifier, 4, () => 0.5);
      expect(oddTileCount(puzzle)).toBe(1);
      expect(puzzle.odd).not.toEqual(puzzle.normal);
      expect(puzzle.oddIndex).toBeGreaterThanOrEqual(0);
      expect(puzzle.oddIndex).toBeLessThan(puzzle.size * puzzle.size);
    },
  );
});

describe("Pattern Sequence", () => {
  it("creates bounded sequences without immediate duplicate steps", () => {
    const sequence = createPatternSequence(9, 6, 2, () => 0.4);
    expect(sequence).toHaveLength(6);
    expect(sequence.every((tile) => tile >= 0 && tile < 9)).toBe(true);
    expect(sequence.every((tile, index) => index === 0 || tile !== sequence[index - 1])).toBe(true);
  });

  it("validates forward and reverse recall", () => {
    const sequence = [0, 1, 3, 2];
    expect(expectedPatternInput(sequence, true)).toEqual([2, 3, 1, 0]);
    expect(isPatternInputCorrect(sequence, sequence, false)).toBe(true);
    expect(isPatternInputCorrect(sequence, [2, 3, 1, 0], true)).toBe(true);
    expect(isPatternInputCorrect(sequence, sequence, true)).toBe(false);
  });
});

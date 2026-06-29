import { describe, expect, it } from "vitest";

import {
  advanceSnake,
  createMemoryDeck,
  createOddTilePuzzle,
  createPatternSequence,
  createSnakeGameState,
  createSolvableLightsPuzzle,
  expectedPatternInput,
  isPatternInputCorrect,
  lightToggleIndices,
  oddTileCount,
  snakeFreeCellsConnected,
  snakeNextCell,
  toggleLights,
  type OddTileModifier,
  type SnakeGameState,
  type SnakeModifier,
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

describe("Snake Trail", () => {
  it.each(["compact", "wrap", "obstacles", "ordered", "long"] as SnakeModifier[])(
    "creates a valid %s board for every variant",
    (modifier) => {
      for (let variant = 0; variant < 8; variant += 1) {
        const game = createSnakeGameState(modifier, variant);
        const occupied = [...game.snake, ...game.obstacles, ...game.targets];
        expect(new Set(occupied).size).toBe(occupied.length);
        expect(occupied.every((cell) => cell >= 0 && cell < game.size * game.size)).toBe(true);
        expect(snakeFreeCellsConnected(game.size, game.obstacles)).toBe(true);
        expect(game.targets).toHaveLength(modifier === "compact" ? 5 : modifier === "long" ? 8 : 7);
      }
    },
  );

  it("wraps only when the round allows it", () => {
    expect(snakeNextCell(0, 6, "W", false)).toBeNull();
    expect(snakeNextCell(0, 6, "W", true)).toBe(5);
    expect(snakeNextCell(0, 6, "N", true)).toBe(30);
  });

  it("grows on collection and reports the final target as a win", () => {
    const state: SnakeGameState = {
      size: 4,
      snake: [5, 4, 0],
      targets: [6, 7],
      targetIndex: 0,
      obstacles: [],
      wrap: false,
      ordered: false,
    };
    const collected = advanceSnake(state, "E");
    expect(collected.event).toBe("collected");
    expect(collected.state.snake).toHaveLength(4);
    expect(collected.state.targetIndex).toBe(1);

    const won = advanceSnake(collected.state, "E");
    expect(won.event).toBe("won");
    expect(won.state.snake).toHaveLength(5);
    expect(won.state.targetIndex).toBe(2);
  });

  it("soft-blocks walls, the trail, obstacles, and out-of-order targets", () => {
    const base: SnakeGameState = {
      size: 4,
      snake: [5, 6, 10, 9],
      targets: [0, 7],
      targetIndex: 0,
      obstacles: [1],
      wrap: false,
      ordered: true,
    };
    expect(advanceSnake({ ...base, snake: [0, 4, 8] }, "W")).toMatchObject({ event: "blocked", reason: "wall" });
    expect(advanceSnake(base, "E")).toMatchObject({ event: "blocked", reason: "self" });
    expect(advanceSnake({ ...base, snake: [0, 4, 8] }, "E")).toMatchObject({ event: "blocked", reason: "obstacle" });
    expect(advanceSnake({ ...base, snake: [6, 5, 4] }, "E")).toMatchObject({ event: "blocked", reason: "order" });
  });
});

import { describe, expect, it } from "vitest";

import {
  advanceZipPath,
  areAdjacent,
  createFullMeshPipePuzzle,
  createZipPuzzleForRound,
  drawFromShuffleBag,
  isPipeBoardSolved,
  isZipSolution,
  pipeConnections,
  pipeCellHasLeak,
  PIPE_PUZZLES,
  rotatePipe,
  rotatePipeCounterClockwise,
  scramblePipePuzzle,
  solvedPipeCells,
  ZIP_PUZZLES,
} from "./game-utils";
import { LOADING_GAME_DEFINITIONS, LOADING_GAME_NAMES } from "./game-definitions";

describe("fair random selection", () => {
  it("draws every option before refilling and avoids immediate repeats", () => {
    const items = LOADING_GAME_NAMES;
    let bag: Array<(typeof items)[number]> = [];
    let previous: (typeof items)[number] | null = null;
    const draws: Array<(typeof items)[number]> = [];

    for (let index = 0; index < 6; index += 1) {
      const draw: { value: (typeof items)[number]; remaining: Array<(typeof items)[number]> } =
        drawFromShuffleBag(items, bag, previous, () => 0.75);
      draws.push(draw.value);
      bag = draw.remaining;
      previous = draw.value;
    }

    expect(new Set(draws.slice(0, 6))).toEqual(new Set(items));
    expect(draws.every((value, index) => index === 0 || value !== draws[index - 1])).toBe(true);
  });

  it("cycles through all puzzle variants before repeating", () => {
    const items = [0, 1, 2];
    let bag: number[] = [];
    let previous: number | null = null;
    const draws: number[] = [];

    for (let index = 0; index < 6; index += 1) {
      const draw: { value: number; remaining: number[] } =
        drawFromShuffleBag(items, bag, previous, () => 0.4);
      draws.push(draw.value);
      bag = draw.remaining;
      previous = draw.value;
    }

    expect(new Set(draws.slice(0, 3))).toEqual(new Set(items));
    expect(new Set(draws.slice(3, 6))).toEqual(new Set(items));
  });

  it("cycles through every modifier for every game before repeating", () => {
    for (const game of LOADING_GAME_NAMES) {
      const modifiers = LOADING_GAME_DEFINITIONS[game].modifiers.map((modifier) => modifier.id);
      let bag: string[] = [];
      let previous: string | null = null;
      const draws: string[] = [];
      for (let index = 0; index < modifiers.length * 2; index += 1) {
        const draw: { value: string; remaining: string[] } =
          drawFromShuffleBag(modifiers, bag, previous, () => 0.6);
        draws.push(draw.value);
        bag = draw.remaining;
        previous = draw.value;
      }
      expect(new Set(draws.slice(0, modifiers.length))).toEqual(new Set(modifiers));
      expect(new Set(draws.slice(modifiers.length))).toEqual(new Set(modifiers));
    }
  });
});

describe("Zip path puzzles", () => {
  it("ships only valid, complete solutions", () => {
    for (const puzzle of ZIP_PUZZLES) {
      expect(isZipSolution(puzzle.solution, puzzle)).toBe(true);
    }
  });

  it("keeps every Zip modifier solvable", () => {
    const compact = createZipPuzzleForRound("compact", 1);
    const extended = createZipPuzzleForRound("extended", 2);
    const reverse = createZipPuzzleForRound("reverse", 3);
    const transformed = createZipPuzzleForRound("corner", 7);

    expect(compact.size).toBe(4);
    expect(isZipSolution(compact.solution, compact)).toBe(true);
    expect(Object.keys(extended.checkpoints)).toHaveLength(6);
    expect(isZipSolution(extended.solution, extended)).toBe(true);
    expect(isZipSolution([...reverse.solution].reverse(), reverse)).toBe(true);
    expect(isZipSolution(transformed.solution, transformed)).toBe(true);
  });

  it("starts only at checkpoint one and rejects non-adjacent moves", () => {
    const puzzle = ZIP_PUZZLES[0];
    expect(advanceZipPath([], 1, puzzle).invalid).toBe(true);
    const started = advanceZipPath([], puzzle.checkpoints[1], puzzle);
    expect(started.invalid).toBe(false);
    expect(advanceZipPath(started.path, 2, puzzle).invalid).toBe(true);
    expect(areAdjacent(0, 1, 5)).toBe(true);
    expect(areAdjacent(0, 5, 5)).toBe(true);
    expect(areAdjacent(0, 6, 5)).toBe(false);
  });

  it("supports one-tile backtracking without duplicating cells", () => {
    const puzzle = ZIP_PUZZLES[0];
    const first = advanceZipPath([], 0, puzzle);
    const second = advanceZipPath(first.path, 1, puzzle);
    const backedUp = advanceZipPath(second.path, 0, puzzle);
    expect(backedUp).toMatchObject({ path: [0], invalid: false, solved: false });
  });

  it("rejects checkpoints out of order and recognizes the final move", () => {
    const puzzle = ZIP_PUZZLES[0];
    const outOfOrderPuzzle = {
      ...puzzle,
      checkpoints: { 1: 0, 2: 24, 3: 1 },
    };
    expect(advanceZipPath([0], 1, outOfOrderPuzzle).invalid).toBe(true);

    const beforeWin = puzzle.solution.slice(0, -1);
    expect(advanceZipPath(beforeWin, puzzle.solution.at(-1) as number, puzzle).solved).toBe(true);
  });
});

describe("Pipe connect puzzles", () => {
  it("rotates pipe connections clockwise", () => {
    expect(pipeConnections("elbow", 0)).toEqual(["N", "E"]);
    expect(pipeConnections("elbow", 90)).toEqual(["E", "S"]);
    expect(rotatePipe(270)).toBe(0);
    expect(rotatePipeCounterClockwise(0)).toBe(270);
  });

  it("ships connected solved layouts", () => {
    for (const puzzle of PIPE_PUZZLES) {
      expect(isPipeBoardSolved(solvedPipeCells(puzzle), puzzle.size)).toBe(true);
    }
    const expanded = createFullMeshPipePuzzle(5);
    expect(isPipeBoardSolved(solvedPipeCells(expanded), expanded.size)).toBe(true);
    expect(solvedPipeCells(expanded).every((_, index, cells) => !pipeCellHasLeak(cells, expanded.size, index))).toBe(true);
  });

  it("rejects unmatched and outward-facing connections", () => {
    const puzzle = PIPE_PUZZLES[1];
    const cells = solvedPipeCells(puzzle);
    cells[0] = { ...cells[0], currentRotation: rotatePipe(cells[0].currentRotation) };
    expect(isPipeBoardSolved(cells, puzzle.size)).toBe(false);
  });

  it("never returns an already solved scramble", () => {
    for (const puzzle of PIPE_PUZZLES) {
      const scrambled = scramblePipePuzzle(puzzle, () => 0);
      expect(isPipeBoardSolved(scrambled, puzzle.size)).toBe(false);
    }
  });
});

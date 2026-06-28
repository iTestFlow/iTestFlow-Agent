export const MEMORY_SYMBOLS = [
  "circle",
  "triangle",
  "square",
  "diamond",
  "star",
  "cross",
  "hexagon",
  "waves",
] as const;

export type MemorySymbol = (typeof MEMORY_SYMBOLS)[number];

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export function createMemoryDeck(
  pairCount: number,
  variantIndex = 0,
  random: () => number = Math.random,
): MemorySymbol[] {
  const symbols = Array.from(
    { length: pairCount },
    (_, index) => MEMORY_SYMBOLS[(index + variantIndex) % MEMORY_SYMBOLS.length],
  );
  return shuffled([...symbols, ...symbols], random);
}

export type LightToggleMode = "orthogonal" | "diagonal" | "wrap";

export function lightToggleIndices(size: number, cellIndex: number, mode: LightToggleMode): number[] {
  const row = Math.floor(cellIndex / size);
  const column = cellIndex % size;
  const offsets = mode === "diagonal"
    ? [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]]
    : [[0, 0], [-1, 0], [0, 1], [1, 0], [0, -1]];

  const indexes = new Set<number>();
  for (const [rowOffset, columnOffset] of offsets) {
    let nextRow = row + rowOffset;
    let nextColumn = column + columnOffset;
    if (mode === "wrap") {
      nextRow = (nextRow + size) % size;
      nextColumn = (nextColumn + size) % size;
    }
    if (nextRow >= 0 && nextRow < size && nextColumn >= 0 && nextColumn < size) {
      indexes.add(nextRow * size + nextColumn);
    }
  }
  return [...indexes];
}

export function toggleLights(
  board: boolean[],
  size: number,
  cellIndex: number,
  mode: LightToggleMode,
): boolean[] {
  const toggled = new Set(lightToggleIndices(size, cellIndex, mode));
  return board.map((lit, index) => toggled.has(index) ? !lit : lit);
}

export function createSolvableLightsPuzzle(
  size: number,
  mode: LightToggleMode,
  variantIndex = 0,
  random: () => number = Math.random,
): { board: boolean[]; solutionMoves: number[] } {
  let board = Array.from({ length: size * size }, () => false);
  const solutionMoves: number[] = [];
  const moveCount = Math.max(3, size + (variantIndex % Math.max(2, size)));
  for (let move = 0; move < moveCount; move += 1) {
    const randomIndex = Math.floor(random() * board.length);
    const cellIndex = (randomIndex + variantIndex + move * 3) % board.length;
    board = toggleLights(board, size, cellIndex, mode);
    solutionMoves.push(cellIndex);
  }
  if (!board.some(Boolean)) {
    const fallbackMove = variantIndex % board.length;
    board = toggleLights(board, size, fallbackMove, mode);
    solutionMoves.push(fallbackMove);
  }
  return { board, solutionMoves };
}

export function createSolvableLightsBoard(
  size: number,
  mode: LightToggleMode,
  variantIndex = 0,
  random: () => number = Math.random,
): boolean[] {
  return createSolvableLightsPuzzle(size, mode, variantIndex, random).board;
}

export type OddTileModifier = "orientation" | "count" | "fill" | "size" | "offset";

export type OddTileVisual = {
  rotation: number;
  marks: number;
  filled: boolean;
  scale: number;
  offsetX: number;
};

export type OddTilePuzzle = {
  size: number;
  oddIndex: number;
  normal: OddTileVisual;
  odd: OddTileVisual;
};

export function createOddTilePuzzle(
  modifier: OddTileModifier,
  variantIndex = 0,
  random: () => number = Math.random,
): OddTilePuzzle {
  const size = variantIndex % 3 === 0 ? 5 : 4;
  const normal: OddTileVisual = {
    rotation: (variantIndex % 4) * 90,
    marks: 1 + (variantIndex % 2),
    filled: variantIndex % 2 === 0,
    scale: 1,
    offsetX: 0,
  };
  const odd = { ...normal };
  if (modifier === "orientation") odd.rotation = (normal.rotation + 45) % 360;
  if (modifier === "count") odd.marks = normal.marks === 1 ? 2 : 1;
  if (modifier === "fill") odd.filled = !normal.filled;
  if (modifier === "size") odd.scale = 0.68;
  if (modifier === "offset") odd.offsetX = 10;
  const oddIndex = (Math.floor(random() * size * size) + variantIndex * 7) % (size * size);
  return { size, oddIndex, normal, odd };
}

export function oddTileCount(puzzle: OddTilePuzzle): number {
  return Array.from({ length: puzzle.size * puzzle.size }, (_, index) => index)
    .filter((index) => index === puzzle.oddIndex)
    .length;
}

export function createPatternSequence(
  tileCount: number,
  length: number,
  variantIndex = 0,
  random: () => number = Math.random,
): number[] {
  const sequence: number[] = [];
  while (sequence.length < length) {
    let tile = (Math.floor(random() * tileCount) + variantIndex + sequence.length) % tileCount;
    if (sequence.length > 0 && tile === sequence[sequence.length - 1]) tile = (tile + 1) % tileCount;
    sequence.push(tile);
  }
  return sequence;
}

export function expectedPatternInput(sequence: number[], reverse: boolean): number[] {
  return reverse ? [...sequence].reverse() : [...sequence];
}

export function isPatternInputCorrect(sequence: number[], input: number[], reverse: boolean): boolean {
  const expected = expectedPatternInput(sequence, reverse);
  return input.length === expected.length && input.every((tile, index) => tile === expected[index]);
}

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

export type SnakeDirection = "N" | "E" | "S" | "W";
export type SnakeModifier = "compact" | "wrap" | "obstacles" | "ordered" | "long";
export type SnakeBlockReason = "wall" | "self" | "obstacle" | "order";
export type SnakeMoveEvent = "moved" | "collected" | "won" | "blocked";

export type SnakeGameState = {
  size: number;
  snake: number[];
  targets: number[];
  targetIndex: number;
  obstacles: number[];
  wrap: boolean;
  ordered: boolean;
};

export type SnakeMoveResult = {
  state: SnakeGameState;
  event: SnakeMoveEvent;
  reason?: SnakeBlockReason;
};

const SNAKE_OFFSETS: Record<SnakeDirection, [number, number]> = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
};

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function snakeFreeCellsConnected(size: number, blockedCells: readonly number[]): boolean {
  const blocked = new Set(blockedCells);
  const start = Array.from({ length: size * size }, (_, index) => index)
    .find((index) => !blocked.has(index));
  if (start === undefined) return false;

  const visited = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cellIndex = queue.shift() as number;
    const row = Math.floor(cellIndex / size);
    const column = cellIndex % size;
    for (const [rowOffset, columnOffset] of Object.values(SNAKE_OFFSETS)) {
      const nextRow = row + rowOffset;
      const nextColumn = column + columnOffset;
      if (nextRow < 0 || nextRow >= size || nextColumn < 0 || nextColumn >= size) continue;
      const nextIndex = nextRow * size + nextColumn;
      if (!blocked.has(nextIndex) && !visited.has(nextIndex)) {
        visited.add(nextIndex);
        queue.push(nextIndex);
      }
    }
  }
  return visited.size === size * size - blocked.size;
}

export function snakeNextCell(
  head: number,
  size: number,
  direction: SnakeDirection,
  wrap: boolean,
): number | null {
  const row = Math.floor(head / size);
  const column = head % size;
  const [rowOffset, columnOffset] = SNAKE_OFFSETS[direction];
  let nextRow = row + rowOffset;
  let nextColumn = column + columnOffset;

  if (wrap) {
    nextRow = (nextRow + size) % size;
    nextColumn = (nextColumn + size) % size;
  } else if (nextRow < 0 || nextRow >= size || nextColumn < 0 || nextColumn >= size) {
    return null;
  }
  return nextRow * size + nextColumn;
}

export function createSnakeGameState(
  modifier: SnakeModifier = "compact",
  variantIndex = 0,
): SnakeGameState {
  const size = modifier === "compact" ? 6 : 7;
  const targetCount = modifier === "compact" ? 5 : modifier === "long" ? 8 : 7;
  const middleRow = Math.floor(size / 2);
  const middleColumn = Math.floor(size / 2);
  const snake = [
    middleRow * size + middleColumn,
    middleRow * size + middleColumn - 1,
    middleRow * size + middleColumn - 2,
  ];
  const random = seededRandom((variantIndex + 1) * 7919 + modifier.length * 101);
  const candidates = shuffled(
    Array.from({ length: size * size }, (_, index) => index)
      .filter((index) => !snake.includes(index)),
    random,
  );

  const obstacles: number[] = [];
  if (modifier === "obstacles") {
    for (const candidate of candidates) {
      if (obstacles.length >= 5) break;
      const nextObstacles = [...obstacles, candidate];
      if (snakeFreeCellsConnected(size, nextObstacles)) obstacles.push(candidate);
    }
  }

  const targets = shuffled(
    candidates.filter((index) => !obstacles.includes(index)),
    random,
  ).slice(0, targetCount);

  return {
    size,
    snake,
    targets,
    targetIndex: 0,
    obstacles,
    wrap: modifier === "wrap",
    ordered: modifier === "ordered",
  };
}

export function advanceSnake(
  state: SnakeGameState,
  direction: SnakeDirection,
): SnakeMoveResult {
  const nextCell = snakeNextCell(state.snake[0], state.size, direction, state.wrap);
  if (nextCell === null) return { state, event: "blocked", reason: "wall" };
  if (state.obstacles.includes(nextCell)) return { state, event: "blocked", reason: "obstacle" };

  const futureTargetIndex = state.targets.indexOf(nextCell);
  if (state.ordered && futureTargetIndex > state.targetIndex) {
    return { state, event: "blocked", reason: "order" };
  }

  const collected = nextCell === state.targets[state.targetIndex];
  const occupiedSnake = collected ? state.snake : state.snake.slice(0, -1);
  if (occupiedSnake.includes(nextCell)) return { state, event: "blocked", reason: "self" };

  const nextSnake = [nextCell, ...state.snake];
  if (!collected) nextSnake.pop();
  const nextTargetIndex = state.targetIndex + (collected ? 1 : 0);
  const nextState = {
    ...state,
    snake: nextSnake,
    targetIndex: nextTargetIndex,
  };

  if (!collected) return { state: nextState, event: "moved" };
  return {
    state: nextState,
    event: nextTargetIndex === state.targets.length ? "won" : "collected",
  };
}

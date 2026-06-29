export type MiniGameProps = {
  onWin?: () => void;
  disabled?: boolean;
  className?: string;
  variantIndex?: number;
  modifierId?: string;
};

export type LoadingGameName =
  | "zip"
  | "pipe"
  | "memory"
  | "lights"
  | "odd"
  | "sequence"
  | "snake";
export type LoadingGameChoice = LoadingGameName | "random";

export type ZipPuzzle = {
  size: number;
  checkpoints: Record<number, number>;
  solution: number[];
  order?: number[];
};

export type ZipMoveResult = {
  path: number[];
  invalid: boolean;
  solved: boolean;
};

export const ZIP_PUZZLES: ZipPuzzle[] = [
  {
    size: 6,
    checkpoints: { 1: 0, 2: 9, 3: 17, 4: 26, 5: 30 },
    solution: [
      0, 1, 2, 3, 4, 5,
      11, 10, 9, 8, 7, 6,
      12, 13, 14, 15, 16, 17,
      23, 22, 21, 20, 19, 18,
      24, 25, 26, 27, 28, 29,
      35, 34, 33, 32, 31, 30,
    ],
  },
  {
    size: 6,
    checkpoints: { 1: 0, 2: 29, 3: 12, 4: 26, 5: 20 },
    solution: [
      0, 1, 2, 3, 4, 5,
      11, 17, 23, 29, 35, 34,
      33, 32, 31, 30, 24, 18,
      12, 6, 7, 8, 9, 10,
      16, 22, 28, 27, 26, 25,
      19, 13, 14, 15, 21, 20,
    ],
  },
  {
    size: 6,
    checkpoints: { 1: 0, 2: 29, 3: 26, 4: 6, 5: 18 },
    solution: [
      0, 1, 2, 3, 4, 5,
      11, 17, 23, 29, 35, 34,
      33, 32, 31, 30, 24, 25,
      26, 27, 28, 22, 16, 10,
      9, 8, 7, 6, 12, 13,
      14, 15, 21, 20, 19, 18,
    ],
  },
];

export const COMPACT_ZIP_PUZZLES: ZipPuzzle[] = [
  {
    size: 4,
    checkpoints: { 1: 0, 2: 7, 3: 4, 4: 11, 5: 12 },
    solution: [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12],
  },
  {
    size: 4,
    checkpoints: { 1: 0, 2: 13, 3: 2, 4: 15, 5: 3 },
    solution: [0, 4, 8, 12, 13, 9, 5, 1, 2, 6, 10, 14, 15, 11, 7, 3],
  },
];

export function chooseRandom<T>(items: readonly T[], random: () => number = Math.random): T {
  return items[Math.floor(random() * items.length)] ?? items[0];
}

export function drawFromShuffleBag<T>(
  items: readonly T[],
  bag: readonly T[],
  previous: T | null,
  random: () => number = Math.random,
): { value: T; remaining: T[] } {
  const nextBag = bag.length ? [...bag] : [...items];
  if (!bag.length) {
    for (let index = nextBag.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [nextBag[index], nextBag[swapIndex]] = [nextBag[swapIndex], nextBag[index]];
    }
  }

  let drawIndex = nextBag.length - 1;
  if (nextBag.length > 1 && previous !== null && Object.is(nextBag[drawIndex], previous)) {
    drawIndex = 0;
  }
  const [value] = nextBag.splice(drawIndex, 1);
  return { value: value ?? items[0], remaining: nextBag };
}

export function checkpointAt(puzzle: ZipPuzzle, cellIndex: number): number | undefined {
  const entry = Object.entries(puzzle.checkpoints).find(([, index]) => index === cellIndex);
  return entry ? Number(entry[0]) : undefined;
}

export function areAdjacent(first: number, second: number, size: number): boolean {
  const firstRow = Math.floor(first / size);
  const firstColumn = first % size;
  const secondRow = Math.floor(second / size);
  const secondColumn = second % size;
  return Math.abs(firstRow - secondRow) + Math.abs(firstColumn - secondColumn) === 1;
}

function checkpointSequence(path: number[], puzzle: ZipPuzzle): number[] {
  return path.flatMap((cell) => {
    const checkpoint = checkpointAt(puzzle, cell);
    return checkpoint === undefined ? [] : [checkpoint];
  });
}

export function zipCheckpointOrder(puzzle: ZipPuzzle): number[] {
  return puzzle.order ?? Object.keys(puzzle.checkpoints).map(Number).sort((left, right) => left - right);
}

export function isZipSolution(path: number[], puzzle: ZipPuzzle): boolean {
  const cellCount = puzzle.size * puzzle.size;
  const order = zipCheckpointOrder(puzzle);
  if (path.length !== cellCount || new Set(path).size !== cellCount) return false;
  if (path[0] !== puzzle.checkpoints[order[0]] || path[path.length - 1] !== puzzle.checkpoints[order[order.length - 1]]) return false;
  if (path.some((cell, index) => index > 0 && !areAdjacent(path[index - 1], cell, puzzle.size))) return false;
  const encountered = checkpointSequence(path, puzzle);
  return encountered.length === order.length && encountered.every((checkpoint, index) => checkpoint === order[index]);
}

export function advanceZipPath(path: number[], nextCell: number, puzzle: ZipPuzzle): ZipMoveResult {
  const cellCount = puzzle.size * puzzle.size;
  if (nextCell < 0 || nextCell >= cellCount) return { path, invalid: true, solved: false };

  if (path.length === 0) {
    const order = zipCheckpointOrder(puzzle);
    if (nextCell !== puzzle.checkpoints[order[0]]) return { path, invalid: true, solved: false };
    const nextPath = [nextCell];
    return { path: nextPath, invalid: false, solved: isZipSolution(nextPath, puzzle) };
  }

  const previousCell = path[path.length - 1];
  if (path.length > 1 && nextCell === path[path.length - 2]) {
    return { path: path.slice(0, -1), invalid: false, solved: false };
  }
  if (!areAdjacent(previousCell, nextCell, puzzle.size) || path.includes(nextCell)) {
    return { path, invalid: true, solved: false };
  }

  const checkpoint = checkpointAt(puzzle, nextCell);
  const visitedCheckpoints = checkpointSequence(path, puzzle).length;
  const order = zipCheckpointOrder(puzzle);
  if (checkpoint !== undefined && checkpoint !== order[visitedCheckpoints]) {
    return { path, invalid: true, solved: false };
  }
  if (checkpoint === order[order.length - 1] && path.length + 1 !== cellCount) {
    return { path, invalid: true, solved: false };
  }

  const nextPath = [...path, nextCell];
  return { path: nextPath, invalid: false, solved: isZipSolution(nextPath, puzzle) };
}

function transformCellIndex(cellIndex: number, size: number, transformIndex: number): number {
  let row = Math.floor(cellIndex / size);
  let column = cellIndex % size;
  if (transformIndex >= 4) column = size - 1 - column;
  for (let turn = 0; turn < transformIndex % 4; turn += 1) {
    [row, column] = [column, size - 1 - row];
  }
  return row * size + column;
}

export function transformZipPuzzle(puzzle: ZipPuzzle, transformIndex: number): ZipPuzzle {
  return {
    ...puzzle,
    checkpoints: Object.fromEntries(
      Object.entries(puzzle.checkpoints).map(([checkpoint, cellIndex]) => [
        Number(checkpoint),
        transformCellIndex(cellIndex, puzzle.size, transformIndex),
      ]),
    ),
    solution: puzzle.solution.map((cellIndex) => transformCellIndex(cellIndex, puzzle.size, transformIndex)),
    order: puzzle.order ? [...puzzle.order] : undefined,
  };
}

export function withZipCheckpointCount(puzzle: ZipPuzzle, checkpointCount: number): ZipPuzzle {
  const lastIndex = puzzle.solution.length - 1;
  const checkpoints: Record<number, number> = {};
  for (let checkpoint = 1; checkpoint <= checkpointCount; checkpoint += 1) {
    const solutionIndex = Math.round(((checkpoint - 1) * lastIndex) / (checkpointCount - 1));
    checkpoints[checkpoint] = puzzle.solution[solutionIndex];
  }
  return { ...puzzle, checkpoints, order: undefined };
}

export function createZipPuzzleForRound(modifierId = "guided", variantIndex = 0): ZipPuzzle {
  const source = modifierId === "compact"
    ? COMPACT_ZIP_PUZZLES[variantIndex % COMPACT_ZIP_PUZZLES.length]
    : ZIP_PUZZLES[variantIndex % ZIP_PUZZLES.length];
  let puzzle = transformZipPuzzle(source, variantIndex % 8);
  if (modifierId === "extended") puzzle = withZipCheckpointCount(puzzle, 6);
  if (modifierId === "reverse") {
    puzzle = { ...puzzle, order: zipCheckpointOrder(puzzle).reverse() };
  }
  return puzzle;
}

export type Direction = "N" | "E" | "S" | "W";
export type PipeType = "straight" | "elbow" | "tee" | "cross";
export type PipeRotation = 0 | 90 | 180 | 270;

export type PipeCell = {
  type: PipeType;
  solutionRotation: PipeRotation;
  currentRotation: PipeRotation;
};

export type PipePuzzle = {
  size: number;
  cells: Array<Omit<PipeCell, "currentRotation">>;
};

export const BASE_CONNECTIONS: Record<PipeType, Direction[]> = {
  straight: ["N", "S"],
  elbow: ["N", "E"],
  tee: ["N", "E", "W"],
  cross: ["N", "E", "S", "W"],
};

const DIRECTION_ORDER: Direction[] = ["N", "E", "S", "W"];
const OPPOSITE_DIRECTION: Record<Direction, Direction> = { N: "S", E: "W", S: "N", W: "E" };
const DIRECTION_OFFSET: Record<Direction, [number, number]> = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
};

const cell = (type: PipeType, solutionRotation: PipeRotation): Omit<PipeCell, "currentRotation"> => ({
  type,
  solutionRotation,
});

export const PIPE_PUZZLES: PipePuzzle[] = [
  {
    size: 4,
    cells: [
      cell("elbow", 90), cell("tee", 180), cell("tee", 180), cell("elbow", 180),
      cell("tee", 90), cell("cross", 0), cell("cross", 0), cell("tee", 270),
      cell("tee", 90), cell("cross", 0), cell("cross", 0), cell("tee", 270),
      cell("elbow", 0), cell("tee", 0), cell("tee", 0), cell("elbow", 270),
    ],
  },
  {
    size: 4,
    cells: [
      cell("elbow", 90), cell("straight", 90), cell("straight", 90), cell("elbow", 180),
      cell("straight", 0), cell("elbow", 90), cell("straight", 90), cell("elbow", 270),
      cell("straight", 0), cell("elbow", 0), cell("straight", 90), cell("elbow", 180),
      cell("elbow", 0), cell("straight", 90), cell("straight", 90), cell("elbow", 270),
    ],
  },
  {
    size: 4,
    cells: [
      cell("elbow", 90), cell("tee", 180), cell("tee", 180), cell("elbow", 180),
      cell("tee", 90), cell("cross", 0), cell("cross", 0), cell("elbow", 270),
      cell("straight", 0), cell("tee", 90), cell("cross", 0), cell("elbow", 180),
      cell("elbow", 0), cell("tee", 0), cell("tee", 0), cell("elbow", 270),
    ],
  },
];

export function rotateDirection(direction: Direction, rotation: PipeRotation): Direction {
  const start = DIRECTION_ORDER.indexOf(direction);
  return DIRECTION_ORDER[(start + rotation / 90) % DIRECTION_ORDER.length];
}

export function pipeConnections(type: PipeType, rotation: PipeRotation): Direction[] {
  return BASE_CONNECTIONS[type].map((direction) => rotateDirection(direction, rotation));
}

export function rotatePipe(rotation: PipeRotation): PipeRotation {
  return ((rotation + 90) % 360) as PipeRotation;
}

export function rotatePipeCounterClockwise(rotation: PipeRotation): PipeRotation {
  return ((rotation + 270) % 360) as PipeRotation;
}

export function isPipeBoardSolved(cells: PipeCell[], size: number, requireConnected = true): boolean {
  if (cells.length !== size * size) return false;

  for (let index = 0; index < cells.length; index += 1) {
    const row = Math.floor(index / size);
    const column = index % size;
    for (const direction of pipeConnections(cells[index].type, cells[index].currentRotation)) {
      const [rowOffset, columnOffset] = DIRECTION_OFFSET[direction];
      const nextRow = row + rowOffset;
      const nextColumn = column + columnOffset;
      if (nextRow < 0 || nextRow >= size || nextColumn < 0 || nextColumn >= size) return false;
      const neighbor = cells[nextRow * size + nextColumn];
      if (!pipeConnections(neighbor.type, neighbor.currentRotation).includes(OPPOSITE_DIRECTION[direction])) return false;
    }
  }

  if (!requireConnected) return true;
  const visited = new Set<number>([0]);
  const queue = [0];
  while (queue.length) {
    const index = queue.shift() as number;
    const row = Math.floor(index / size);
    const column = index % size;
    for (const direction of pipeConnections(cells[index].type, cells[index].currentRotation)) {
      const [rowOffset, columnOffset] = DIRECTION_OFFSET[direction];
      const nextIndex = (row + rowOffset) * size + column + columnOffset;
      if (!visited.has(nextIndex)) {
        visited.add(nextIndex);
        queue.push(nextIndex);
      }
    }
  }
  return visited.size === cells.length;
}

export function solvedPipeCells(puzzle: PipePuzzle): PipeCell[] {
  return puzzle.cells.map((pipe) => ({ ...pipe, currentRotation: pipe.solutionRotation }));
}

export function scramblePipePuzzle(puzzle: PipePuzzle, random: () => number = Math.random): PipeCell[] {
  const rotations: PipeRotation[] = [0, 90, 180, 270];
  const scrambled = puzzle.cells.map((pipe) => ({
    ...pipe,
    currentRotation: chooseRandom(rotations, random),
  }));
  if (isPipeBoardSolved(scrambled, puzzle.size)) {
    const rotatableIndex = scrambled.findIndex((pipe) => pipe.type !== "cross");
    if (rotatableIndex >= 0) {
      scrambled[rotatableIndex] = {
        ...scrambled[rotatableIndex],
        currentRotation: rotatePipe(scrambled[rotatableIndex].currentRotation),
      };
    }
  }
  return scrambled;
}

export function createFullMeshPipePuzzle(size: number): PipePuzzle {
  const cells: Array<Omit<PipeCell, "currentRotation">> = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const top = row === 0;
      const bottom = row === size - 1;
      const left = column === 0;
      const right = column === size - 1;
      if (top && left) cells.push(cell("elbow", 90));
      else if (top && right) cells.push(cell("elbow", 180));
      else if (bottom && left) cells.push(cell("elbow", 0));
      else if (bottom && right) cells.push(cell("elbow", 270));
      else if (top) cells.push(cell("tee", 180));
      else if (bottom) cells.push(cell("tee", 0));
      else if (left) cells.push(cell("tee", 90));
      else if (right) cells.push(cell("tee", 270));
      else cells.push(cell("cross", 0));
    }
  }
  return { size, cells };
}

export function pipeCellHasLeak(cells: PipeCell[], size: number, index: number): boolean {
  const row = Math.floor(index / size);
  const column = index % size;
  return pipeConnections(cells[index].type, cells[index].currentRotation).some((direction) => {
    const [rowOffset, columnOffset] = DIRECTION_OFFSET[direction];
    const nextRow = row + rowOffset;
    const nextColumn = column + columnOffset;
    if (nextRow < 0 || nextRow >= size || nextColumn < 0 || nextColumn >= size) return true;
    const neighbor = cells[nextRow * size + nextColumn];
    return !pipeConnections(neighbor.type, neighbor.currentRotation).includes(OPPOSITE_DIRECTION[direction]);
  });
}

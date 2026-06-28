"use client";

import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

import {
  createFullMeshPipePuzzle,
  isPipeBoardSolved,
  pipeCellHasLeak,
  pipeConnections,
  PIPE_PUZZLES,
  rotatePipe,
  rotatePipeCounterClockwise,
  scramblePipePuzzle,
  type Direction,
  type MiniGameProps,
} from "./game-utils";

const PIPE_LINE: Record<Direction, { x2: number; y2: number }> = {
  N: { x2: 50, y2: 4 },
  E: { x2: 96, y2: 50 },
  S: { x2: 50, y2: 96 },
  W: { x2: 4, y2: 50 },
};

export function PipeConnectGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "leaks",
}: MiniGameProps) {
  const [puzzle] = useState(() => {
    if (modifierId === "expanded") return createFullMeshPipePuzzle(5);
    if (modifierId === "sparse") return PIPE_PUZZLES[1];
    return PIPE_PUZZLES[variantIndex % PIPE_PUZZLES.length];
  });
  const [lockedIndexes] = useState(() => {
    if (modifierId !== "locked") return new Set<number>();
    const candidates = puzzle.cells
      .map((pipe, index) => pipe.type === "cross" ? -1 : index)
      .filter((index) => index >= 0);
    return new Set([
      candidates[variantIndex % candidates.length],
      candidates[(variantIndex + Math.floor(candidates.length / 2)) % candidates.length],
    ]);
  });
  const [cells, setCells] = useState(() => {
    const scrambled = scramblePipePuzzle(puzzle);
    lockedIndexes.forEach((index) => {
      scrambled[index] = { ...scrambled[index], currentRotation: scrambled[index].solutionRotation };
    });
    if (isPipeBoardSolved(scrambled, puzzle.size)) {
      const rotatable = scrambled.findIndex((pipe, index) => !lockedIndexes.has(index) && pipe.type !== "cross");
      if (rotatable >= 0) scrambled[rotatable] = { ...scrambled[rotatable], currentRotation: rotatePipe(scrambled[rotatable].currentRotation) };
    }
    return scrambled;
  });
  const wonRef = useRef(false);

  function rotateCell(index: number) {
    if (disabled || wonRef.current || lockedIndexes.has(index)) return;
    setCells((current) => {
      const next = current.map((pipe, pipeIndex) => (
        pipeIndex === index
          ? {
              ...pipe,
              currentRotation: modifierId === "counter"
                ? rotatePipeCounterClockwise(pipe.currentRotation)
                : rotatePipe(pipe.currentRotation),
            }
          : pipe
      ));
      if (isPipeBoardSolved(next, puzzle.size) && !wonRef.current) {
        wonRef.current = true;
        window.setTimeout(() => onWin?.(), 0);
      }
      return next;
    });
  }

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">Rotate the tiles until every pipe joins without open ends.</p>
      <div
        className="mx-auto grid aspect-square w-full max-w-[288px] overflow-hidden rounded-xl border border-border bg-background"
        style={{ gridTemplateColumns: `repeat(${puzzle.size}, minmax(0, 1fr))` }}
        role="group"
        aria-label={`Pipe connect puzzle, ${puzzle.size} by ${puzzle.size} grid`}
      >
        {cells.map((pipe, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled || wonRef.current || lockedIndexes.has(index)}
            onClick={() => rotateCell(index)}
            aria-label={`Row ${Math.floor(index / puzzle.size) + 1}, column ${(index % puzzle.size) + 1}, ${pipe.type} pipe, rotated ${pipe.currentRotation} degrees`}
            className={cn(
              "flex aspect-square items-center justify-center border-b border-r border-border/70 bg-card outline-none transition-colors hover:bg-muted/70 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              lockedIndexes.has(index) && "bg-muted/70 opacity-75",
              modifierId === "leaks" && pipeCellHasLeak(cells, puzzle.size, index) && "bg-destructive/10 ring-1 ring-inset ring-destructive/35",
              wonRef.current && "bg-success/10",
            )}
          >
            <svg
              viewBox="0 0 100 100"
              className={cn(
                "size-[78%] text-primary motion-reduce:transition-none",
                modifierId === "counter" ? "transition-none" : "transition-transform duration-150",
              )}
              style={{ transform: `rotate(${pipe.currentRotation}deg)` }}
              aria-hidden="true"
            >
              {pipeConnections(pipe.type, 0).map((direction) => (
                <line
                  key={direction}
                  x1="50"
                  y1="50"
                  x2={PIPE_LINE[direction].x2}
                  y2={PIPE_LINE[direction].y2}
                  stroke="currentColor"
                  strokeWidth="16"
                  strokeLinecap="round"
                />
              ))}
              <circle cx="50" cy="50" r="10" fill="currentColor" />
              {lockedIndexes.has(index) ? (
                <rect x="39" y="39" width="22" height="20" rx="4" fill="hsl(var(--card))" stroke="currentColor" strokeWidth="4" />
              ) : null}
            </svg>
          </button>
        ))}
      </div>
      <p className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite">
        {wonRef.current
          ? "All pipes connected."
          : `Select any unlocked tile to rotate it ${modifierId === "counter" ? "counterclockwise" : "clockwise"}.`}
      </p>
    </div>
  );
}

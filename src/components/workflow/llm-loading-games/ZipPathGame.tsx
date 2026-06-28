"use client";

import { useCallback, useMemo, useRef, useState, type PointerEvent } from "react";

import { cn } from "@/lib/utils";

import {
  advanceZipPath,
  checkpointAt,
  createZipPuzzleForRound,
  zipCheckpointOrder,
  type MiniGameProps,
} from "./game-utils";

export function ZipPathGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "guided",
}: MiniGameProps) {
  const [puzzle] = useState(() => createZipPuzzleForRound(modifierId, variantIndex));
  const [path, setPath] = useState<number[]>([]);
  const [dragging, setDragging] = useState(false);
  const [invalidMove, setInvalidMove] = useState(false);
  const wonRef = useRef(false);
  const pathRef = useRef<number[]>([]);

  const pathPoints = useMemo(
    () => path.map((cell) => `${(cell % puzzle.size) + 0.5},${Math.floor(cell / puzzle.size) + 0.5}`).join(" "),
    [path, puzzle.size],
  );
  const checkpointOrder = useMemo(() => zipCheckpointOrder(puzzle), [puzzle]);
  const visitedCheckpointCount = path.filter((cell) => checkpointAt(puzzle, cell) !== undefined).length;
  const nextCheckpoint = checkpointOrder[visitedCheckpointCount];
  const startCheckpoint = checkpointOrder[0];
  const finalCheckpoint = checkpointOrder[checkpointOrder.length - 1];
  const cellCount = puzzle.size * puzzle.size;

  const moveTo = useCallback((cellIndex: number) => {
    if (disabled || wonRef.current) return false;
    const result = advanceZipPath(pathRef.current, cellIndex, puzzle);
    setInvalidMove(result.invalid);
    if (result.invalid) return false;
    pathRef.current = result.path;
    setPath(result.path);
    if (result.solved && !wonRef.current) {
      wonRef.current = true;
      window.setTimeout(() => onWin?.(), 0);
    }
    return true;
  }, [disabled, onWin, puzzle]);

  function beginPath(cellIndex: number) {
    if (disabled) return;
    setDragging(true);
    if (!moveTo(cellIndex)) setDragging(false);
  }

  function continuePath(cellIndex: number) {
    if (!dragging || disabled) return;
    if (!moveTo(cellIndex)) setDragging(false);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging || disabled) return;
    if (event.pointerType === "touch") event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-zip-cell]");
    const cellIndex = Number(target?.dataset.zipCell);
    if (Number.isInteger(cellIndex) && cellIndex !== path[path.length - 1]) continuePath(cellIndex);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        Start at {startCheckpoint}, continue {modifierId === "reverse" ? "downward" : "upward"} to {finalCheckpoint}, and fill every tile.
      </p>
      <div
        className="relative mx-auto grid aspect-square w-full max-w-[288px] touch-none select-none overflow-hidden rounded-xl border border-border bg-background"
        style={{ gridTemplateColumns: `repeat(${puzzle.size}, minmax(0, 1fr))` }}
        role="group"
        aria-label={`Zip path puzzle, ${puzzle.size} by ${puzzle.size} grid`}
        onPointerMove={handlePointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") setDragging(false);
        }}
      >
        {Array.from({ length: puzzle.size * puzzle.size }, (_, cellIndex) => {
          const checkpoint = checkpointAt(puzzle, cellIndex);
          const pathIndex = path.indexOf(cellIndex);
          const filled = pathIndex >= 0;
          const endpoint = path[path.length - 1] === cellIndex;
          return (
            <button
              key={cellIndex}
              type="button"
              data-zip-cell={cellIndex}
              disabled={disabled || wonRef.current}
              aria-label={
                checkpoint
                  ? `Row ${Math.floor(cellIndex / puzzle.size) + 1}, column ${(cellIndex % puzzle.size) + 1}, checkpoint ${checkpoint}`
                  : `Row ${Math.floor(cellIndex / puzzle.size) + 1}, column ${(cellIndex % puzzle.size) + 1}`
              }
              aria-pressed={filled}
              className={cn(
                "relative z-10 flex aspect-square items-center justify-center border-b border-r border-border/70 text-xs font-semibold outline-none transition-colors focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                filled ? "bg-primary/12 text-primary" : "bg-card hover:bg-muted/70",
                endpoint && "bg-primary/20 ring-2 ring-inset ring-primary/50",
                modifierId === "guided" && checkpoint === nextCheckpoint && "bg-info/15 ring-2 ring-inset ring-info/50",
                wonRef.current && filled && "bg-success/15 text-success",
              )}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                beginPath(cellIndex);
              }}
              onPointerEnter={() => continuePath(cellIndex)}
              onClick={(event) => {
                if (event.detail === 0) moveTo(cellIndex);
              }}
            >
              {checkpoint ? (
                <span className="relative z-20 flex size-6 items-center justify-center rounded-full border border-primary/40 bg-card text-[11px] text-foreground shadow-sm">
                  {checkpoint}
                </span>
              ) : null}
            </button>
          );
        })}
        <svg
          className="pointer-events-none absolute inset-0 z-20 size-full"
          viewBox={`0 0 ${puzzle.size} ${puzzle.size}`}
          aria-hidden="true"
        >
          <polyline
            points={pathPoints}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="0.16"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.8"
          />
        </svg>
      </div>
      <p className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite">
        {invalidMove ? "That tile cannot be added there. Continue from the current endpoint." : `${path.length} of ${cellCount} tiles filled`}
      </p>
    </div>
  );
}

"use client";

import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

import {
  createOddTilePuzzle,
  type OddTileModifier,
  type OddTileVisual,
} from "./extra-game-utils";
import type { MiniGameProps } from "./game-utils";

function OddGlyph({ visual }: { visual: OddTileVisual }) {
  return (
    <svg viewBox="0 0 100 100" className="size-[72%] text-primary" aria-hidden="true">
      <g transform={`translate(${visual.offsetX} 0) rotate(${visual.rotation} 50 50) translate(50 50) scale(${visual.scale}) translate(-50 -50)`}>
        <path
          d="M50 17 82 50 50 83 18 50Z"
          fill={visual.filled ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="7"
          strokeLinejoin="round"
        />
        {Array.from({ length: visual.marks }, (_, index) => (
          <circle
            key={index}
            cx={visual.marks === 1 ? 50 : 40 + index * 20}
            cy="50"
            r="5"
            fill={visual.filled ? "hsl(var(--card))" : "currentColor"}
          />
        ))}
      </g>
    </svg>
  );
}

export function OddTileGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "orientation",
}: MiniGameProps) {
  const [puzzle] = useState(() => createOddTilePuzzle(modifierId as OddTileModifier, variantIndex));
  const [message, setMessage] = useState("Select the tile that differs from the others.");
  const wonRef = useRef(false);

  function chooseTile(index: number) {
    if (disabled || wonRef.current) return;
    if (index !== puzzle.oddIndex) {
      setMessage("Not that one. Look closely and try again.");
      return;
    }
    wonRef.current = true;
    setMessage("You found the odd tile.");
    window.setTimeout(() => onWin?.(), 0);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">Find the single tile with a visual difference.</p>
      <div
        className="mx-auto grid aspect-square w-full max-w-[288px] gap-1"
        style={{ gridTemplateColumns: `repeat(${puzzle.size}, minmax(0, 1fr))` }}
        role="group"
        aria-label={`Find the odd tile, ${puzzle.size} by ${puzzle.size} grid`}
      >
        {Array.from({ length: puzzle.size * puzzle.size }, (_, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled || wonRef.current}
            onClick={() => chooseTile(index)}
            aria-label={`Tile at row ${Math.floor(index / puzzle.size) + 1}, column ${(index % puzzle.size) + 1}`}
            className={cn(
              "flex aspect-square items-center justify-center rounded-md border border-border bg-card outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
              wonRef.current && index === puzzle.oddIndex && "border-success/50 bg-success/10 text-success",
            )}
          >
            <OddGlyph visual={index === puzzle.oddIndex ? puzzle.odd : puzzle.normal} />
          </button>
        ))}
      </div>
      <p className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite">{message}</p>
    </div>
  );
}

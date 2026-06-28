"use client";

import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

import {
  createSolvableLightsBoard,
  toggleLights,
  type LightToggleMode,
} from "./extra-game-utils";
import type { MiniGameProps } from "./game-utils";

function lightsConfig(modifierId: string): { size: number; mode: LightToggleMode } {
  if (modifierId === "small") return { size: 3, mode: "orthogonal" };
  if (modifierId === "large") return { size: 5, mode: "orthogonal" };
  if (modifierId === "diagonal") return { size: 4, mode: "diagonal" };
  if (modifierId === "wrap") return { size: 4, mode: "wrap" };
  return { size: 4, mode: "orthogonal" };
}

export function LightsOutGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "standard",
}: MiniGameProps) {
  const [{ size, mode }] = useState(() => lightsConfig(modifierId));
  const [board, setBoard] = useState(() => createSolvableLightsBoard(size, mode, variantIndex));
  const wonRef = useRef(false);
  const litCount = board.filter(Boolean).length;

  function pressLight(index: number) {
    if (disabled || wonRef.current) return;
    const next = toggleLights(board, size, index, mode);
    setBoard(next);
    if (!next.some(Boolean) && !wonRef.current) {
      wonRef.current = true;
      window.setTimeout(() => onWin?.(), 0);
    }
  }

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">Turn every light off. Each press also changes its neighbors.</p>
      <div
        className="mx-auto grid aspect-square w-full max-w-[288px] gap-1.5 rounded-xl border border-border bg-background p-2"
        style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
        role="group"
        aria-label={`Lights Out, ${size} by ${size} grid`}
      >
        {board.map((lit, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled || wonRef.current}
            aria-label={`Row ${Math.floor(index / size) + 1}, column ${(index % size) + 1}, ${lit ? "on" : "off"}`}
            aria-pressed={lit}
            onClick={() => pressLight(index)}
            className={cn(
              "aspect-square rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              lit
                ? "border-warning/60 bg-warning/25 shadow-[inset_0_0_18px_hsl(var(--warning)/0.18)]"
                : "border-border bg-muted/50 hover:bg-muted",
            )}
          >
            <span className={cn("mx-auto block size-2.5 rounded-full", lit ? "bg-warning" : "bg-muted-foreground/25")} aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite">
        {litCount} {litCount === 1 ? "light" : "lights"} remaining
      </p>
    </div>
  );
}

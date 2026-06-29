"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { createMemoryDeck, type MemorySymbol } from "./extra-game-utils";
import type { MiniGameProps } from "./game-utils";

function MemorySymbolIcon({ symbol }: { symbol: MemorySymbol }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 100 100" className="size-8" aria-hidden="true">
      {symbol === "circle" ? <circle cx="50" cy="50" r="28" {...common} /> : null}
      {symbol === "triangle" ? <path d="M50 18 82 78H18Z" {...common} /> : null}
      {symbol === "square" ? <rect x="23" y="23" width="54" height="54" rx="6" {...common} /> : null}
      {symbol === "diamond" ? <path d="M50 16 84 50 50 84 16 50Z" {...common} /> : null}
      {symbol === "star" ? <path d="m50 14 10 23 25 3-19 17 6 25-22-13-22 13 6-25-19-17 25-3Z" {...common} /> : null}
      {symbol === "cross" ? <path d="M50 20v60M20 50h60" {...common} /> : null}
      {symbol === "hexagon" ? <path d="m50 15 30 18v34L50 85 20 67V33Z" {...common} /> : null}
      {symbol === "waves" ? <path d="M15 37c12-13 23 13 35 0s23 13 35 0M15 63c12-13 23 13 35 0s23 13 35 0" {...common} /> : null}
    </svg>
  );
}

export function MemoryMatchGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "six-pairs",
}: MiniGameProps) {
  const pairCount = modifierId === "four-pairs" ? 4 : modifierId === "eight-pairs" ? 8 : 6;
  const [deck] = useState(() => createMemoryDeck(pairCount, variantIndex));
  const [revealed, setRevealed] = useState<number[]>([]);
  const [matched, setMatched] = useState<Set<MemorySymbol>>(() => new Set());
  const [locked, setLocked] = useState(false);
  const [previewActive, setPreviewActive] = useState(modifierId === "preview");
  const [peekAvailable, setPeekAvailable] = useState(modifierId === "peek");
  const [peekActive, setPeekActive] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const wonRef = useRef(false);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  function finishMatch(symbol: MemorySymbol) {
    const nextMatched = new Set(matched).add(symbol);
    setMatched(nextMatched);
    setRevealed([]);
    if (nextMatched.size === pairCount && !wonRef.current) {
      wonRef.current = true;
      window.setTimeout(() => onWin?.(), 0);
    }
  }

  function chooseCard(index: number) {
    if (disabled || locked || previewActive || peekActive || wonRef.current || revealed.includes(index) || matched.has(deck[index])) return;
    if (revealed.length === 0) {
      setRevealed([index]);
      return;
    }

    const firstIndex = revealed[0];
    setRevealed([firstIndex, index]);
    if (deck[firstIndex] === deck[index]) {
      finishMatch(deck[index]);
      return;
    }
    setLocked(true);
    timeoutRef.current = window.setTimeout(() => {
      setRevealed([]);
      setLocked(false);
      timeoutRef.current = null;
    }, 550);
  }

  function usePeek() {
    if (!peekAvailable || disabled) return;
    setPeekAvailable(false);
    setPeekActive(true);
    timeoutRef.current = window.setTimeout(() => {
      setPeekActive(false);
      timeoutRef.current = null;
    }, 900);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Match every pair of symbols.</p>
        {modifierId === "peek" && peekAvailable ? (
          <Button type="button" variant="outline" size="xs" onClick={usePeek}>Peek once</Button>
        ) : null}
        {previewActive ? (
          <Button type="button" variant="outline" size="xs" onClick={() => setPreviewActive(false)}>Hide cards and start</Button>
        ) : null}
      </div>
      <div
        className="mx-auto grid w-full max-w-[288px] grid-cols-4 gap-1.5"
        role="group"
        aria-label={`Memory matching game with ${pairCount} pairs`}
      >
        {deck.map((symbol, index) => {
          const faceUp = previewActive || peekActive || revealed.includes(index) || matched.has(symbol);
          return (
            <button
              key={`${symbol}-${index}`}
              type="button"
              disabled={disabled || matched.has(symbol) || wonRef.current}
              onClick={() => chooseCard(index)}
              aria-label={`Card ${index + 1}, ${faceUp ? symbol : "hidden"}`}
              aria-pressed={faceUp}
              className={cn(
                "flex aspect-square items-center justify-center rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                faceUp
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
                matched.has(symbol) && "border-success/40 bg-success/10 text-success",
              )}
            >
              {faceUp ? <MemorySymbolIcon symbol={symbol} /> : <span className="text-lg font-semibold" aria-hidden="true">?</span>}
            </button>
          );
        })}
      </div>
      <p className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite">
        {matched.size} of {pairCount} pairs matched
      </p>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { createNumberFlipDeck } from "./extra-game-utils";
import type { MiniGameProps } from "./game-utils";

type NumberFlipConfig = {
  cardCount: number;
  columns: 3 | 4;
  previewFirst?: boolean;
  peekAvailable?: boolean;
};

function numberFlipConfig(modifierId: string): NumberFlipConfig {
  if (modifierId === "quick-six") return { cardCount: 6, columns: 3 };
  if (modifierId === "full-twelve") return { cardCount: 12, columns: 4 };
  if (modifierId === "preview") return { cardCount: 9, columns: 3, previewFirst: true };
  if (modifierId === "peek") return { cardCount: 9, columns: 3, peekAvailable: true };
  return { cardCount: 9, columns: 3 };
}

export function NumberFlipGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "classic-nine",
}: MiniGameProps) {
  const config = numberFlipConfig(modifierId);
  const [deck] = useState(() => createNumberFlipDeck(config.cardCount, variantIndex));
  const [revealed, setRevealed] = useState<number[]>([]);
  const [nextNumber, setNextNumber] = useState(1);
  const [previewActive, setPreviewActive] = useState(Boolean(config.previewFirst));
  const [peekAvailable, setPeekAvailable] = useState(Boolean(config.peekAvailable));
  const [peekActive, setPeekActive] = useState(false);
  const [locked, setLocked] = useState(false);
  const [wrongIndex, setWrongIndex] = useState<number | null>(null);
  const [message, setMessage] = useState(config.previewFirst ? "Study the board, then hide the cards to begin. Find 1." : "Find 1.");
  const revealedRef = useRef<number[]>([]);
  const nextNumberRef = useRef(1);
  const lockedRef = useRef(false);
  const previewActiveRef = useRef(Boolean(config.previewFirst));
  const peekActiveRef = useRef(false);
  const wonRef = useRef(false);
  const interactionTimerRef = useRef<number | null>(null);
  const winTimerRef = useRef<number | null>(null);

  function clearInteractionTimer() {
    if (interactionTimerRef.current !== null) {
      window.clearTimeout(interactionTimerRef.current);
      interactionTimerRef.current = null;
    }
  }

  useEffect(() => () => {
    clearInteractionTimer();
    if (winTimerRef.current !== null) window.clearTimeout(winTimerRef.current);
  }, []);

  function hidePreviewAndStart() {
    if (disabled || wonRef.current) return;
    previewActiveRef.current = false;
    setPreviewActive(false);
    setMessage("Find 1.");
  }

  function usePeek() {
    if (disabled || !peekAvailable || lockedRef.current || peekActiveRef.current || wonRef.current) return;
    setPeekAvailable(false);
    peekActiveRef.current = true;
    lockedRef.current = true;
    setPeekActive(true);
    setLocked(true);
    setMessage("Memorize the board.");
    clearInteractionTimer();
    interactionTimerRef.current = window.setTimeout(() => {
      interactionTimerRef.current = null;
      peekActiveRef.current = false;
      lockedRef.current = false;
      setPeekActive(false);
      setLocked(false);
      setMessage(nextNumberRef.current === 1 ? "Find 1." : `Next number: ${nextNumberRef.current}.`);
    }, 900);
  }

  function resetAfterMistake(index: number, selectedNumber: number, expectedNumber: number) {
    lockedRef.current = true;
    setLocked(true);
    setWrongIndex(index);
    setMessage(`That was ${selectedNumber}. You needed ${expectedNumber}. Starting over.`);
    clearInteractionTimer();
    interactionTimerRef.current = window.setTimeout(() => {
      interactionTimerRef.current = null;
      revealedRef.current = [];
      nextNumberRef.current = 1;
      lockedRef.current = false;
      setRevealed([]);
      setNextNumber(1);
      setWrongIndex(null);
      setLocked(false);
      setMessage("Find 1.");
    }, 550);
  }

  function chooseCard(index: number) {
    if (
      disabled
      || lockedRef.current
      || previewActiveRef.current
      || peekActiveRef.current
      || wonRef.current
      || revealedRef.current.includes(index)
    ) return;

    const selectedNumber = deck[index];
    const expectedNumber = nextNumberRef.current;
    if (selectedNumber !== expectedNumber) {
      resetAfterMistake(index, selectedNumber, expectedNumber);
      return;
    }

    const nextRevealed = [...revealedRef.current, index];
    revealedRef.current = nextRevealed;
    setRevealed(nextRevealed);
    if (selectedNumber !== deck.length) {
      const followingNumber = expectedNumber + 1;
      nextNumberRef.current = followingNumber;
      setNextNumber(followingNumber);
      setMessage(`Next number: ${followingNumber}.`);
      return;
    }

    wonRef.current = true;
    lockedRef.current = true;
    setLocked(true);
    setMessage("Number sequence complete.");
    winTimerRef.current = window.setTimeout(() => {
      winTimerRef.current = null;
      onWin?.();
    }, 0);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Find the numbers in ascending order.</p>
        {previewActive ? (
          <Button type="button" variant="outline" size="xs" className="h-11" disabled={disabled} onClick={hidePreviewAndStart}>
            Hide cards and start
          </Button>
        ) : null}
        {peekAvailable ? (
          <Button type="button" variant="outline" size="xs" className="h-11" disabled={disabled || locked || wonRef.current} onClick={usePeek}>
            Peek once
          </Button>
        ) : null}
      </div>

      <div
        className={cn("mx-auto grid w-full max-w-[288px] gap-1.5", config.columns === 3 ? "grid-cols-3" : "grid-cols-4")}
        role="group"
        aria-label={`Number Flip game with ${deck.length} cards. ${previewActive ? "Preview the board." : `Next number: ${nextNumber}.`}`}
        aria-busy={locked || undefined}
      >
        {deck.map((number, index) => {
          const correctlyRevealed = revealed.includes(index);
          const incorrectlyRevealed = wrongIndex === index;
          const faceUp = previewActive || peekActive || correctlyRevealed || incorrectlyRevealed;
          const cardDisabled = disabled || locked || previewActive || peekActive || wonRef.current || correctlyRevealed;
          const accessibleState = correctlyRevealed
            ? ", correct"
            : incorrectlyRevealed
              ? ", incorrect"
              : faceUp
                ? ", revealed"
                : "";
          return (
            <button
              key={number}
              type="button"
              disabled={cardDisabled}
              onClick={() => chooseCard(index)}
              aria-label={faceUp ? `Card ${index + 1}, number ${number}${accessibleState}` : `Card ${index + 1}, hidden`}
              aria-pressed={faceUp}
              className={cn(
                "flex aspect-square min-h-11 items-center justify-center rounded-lg border text-lg font-semibold tabular-nums outline-none transition-[background-color,border-color,color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                faceUp
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
                correctlyRevealed && "border-success/40 bg-success/10 text-success",
                incorrectlyRevealed && "border-destructive/50 bg-destructive/10 text-destructive",
              )}
            >
              {faceUp ? <span>{number}</span> : <span aria-hidden="true">?</span>}
            </button>
          );
        })}
      </div>

      <p className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite" aria-atomic="true">
        <span>{revealed.length} of {deck.length} found</span> · <span>{message}</span>
      </p>
    </div>
  );
}

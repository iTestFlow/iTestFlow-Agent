"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  createPatternSequence,
  expectedPatternInput,
} from "./extra-game-utils";
import type { MiniGameProps } from "./game-utils";

function patternConfig(modifierId: string, round: number) {
  if (modifierId === "quick") return { size: 2, length: 4, reverse: false };
  if (modifierId === "long") return { size: 2, length: 6, reverse: false };
  if (modifierId === "spatial") return { size: 3, length: 5, reverse: false };
  if (modifierId === "reverse") return { size: 2, length: 5, reverse: true };
  if (modifierId === "growing") return { size: 2, length: 3 + round, reverse: false };
  return { size: 2, length: 5, reverse: false };
}

function tileName(index: number, size: number) {
  return `row ${Math.floor(index / size) + 1}, column ${(index % size) + 1}`;
}

export function PatternSequenceGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "quick",
}: MiniGameProps) {
  const [round, setRound] = useState(0);
  const config = patternConfig(modifierId, round);
  const [sequence, setSequence] = useState(() => createPatternSequence(config.size ** 2, config.length, variantIndex));
  const [phase, setPhase] = useState<"watching" | "input">("watching");
  const [activeTile, setActiveTile] = useState<number | null>(null);
  const [input, setInput] = useState<number[]>([]);
  const [message, setMessage] = useState("Watch the pattern.");
  const [playbackKey, setPlaybackKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const wonRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    setInput([]);
    setActiveTile(null);
    setPhase("watching");
    setMessage(reducedMotion ? "Review the pattern, then start recall." : "Watch the pattern.");
    if (reducedMotion) return;

    sequence.forEach((tile, index) => {
      timersRef.current.push(window.setTimeout(() => setActiveTile(tile), 300 + index * 620));
      timersRef.current.push(window.setTimeout(() => setActiveTile(null), 720 + index * 620));
    });
    timersRef.current.push(window.setTimeout(() => {
      setPhase("input");
      setMessage(config.reverse ? "Repeat the pattern in reverse." : "Repeat the pattern.");
    }, 420 + sequence.length * 620));

    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current = [];
    };
  }, [config.reverse, playbackKey, reducedMotion, sequence]);

  const expected = useMemo(() => expectedPatternInput(sequence, config.reverse), [config.reverse, sequence]);

  function startRecall() {
    setActiveTile(null);
    setInput([]);
    setPhase("input");
    setMessage(config.reverse ? "Repeat the pattern in reverse." : "Repeat the pattern.");
  }

  function replayPattern() {
    if (disabled || wonRef.current) return;
    setPlaybackKey((current) => current + 1);
  }

  function chooseTile(tile: number) {
    if (disabled || phase !== "input" || wonRef.current) return;
    const nextInput = [...input, tile];
    if (tile !== expected[nextInput.length - 1]) {
      setInput([]);
      setMessage("That was not the sequence. Try again or replay it.");
      return;
    }
    setInput(nextInput);
    if (nextInput.length !== expected.length) return;

    if (modifierId === "growing" && round < 2) {
      const nextRound = round + 1;
      const nextConfig = patternConfig(modifierId, nextRound);
      setRound(nextRound);
      setSequence(createPatternSequence(nextConfig.size ** 2, nextConfig.length, variantIndex + nextRound));
      setPlaybackKey((current) => current + 1);
      setMessage(`Round ${nextRound + 1} of 3.`);
      return;
    }

    wonRef.current = true;
    setMessage("Pattern complete.");
    window.setTimeout(() => onWin?.(), 0);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {modifierId === "growing" ? `Remember the pattern · round ${round + 1} of 3` : "Remember and repeat the highlighted pattern."}
        </p>
        {phase === "input" ? <Button type="button" variant="outline" size="xs" onClick={replayPattern}>Replay pattern</Button> : null}
      </div>

      {reducedMotion && phase === "watching" ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">Pattern: {sequence.map((tile) => tileName(tile, config.size)).join(" → ")}</p>
          <Button type="button" size="sm" onClick={startRecall}>Start recall</Button>
        </div>
      ) : null}

      <div
        className="mx-auto grid aspect-square w-full max-w-[288px] gap-2 rounded-xl border border-border bg-background p-3"
        style={{ gridTemplateColumns: `repeat(${config.size}, minmax(0, 1fr))` }}
        role="group"
        aria-label={`Pattern sequence, ${config.size} by ${config.size} grid`}
      >
        {Array.from({ length: config.size ** 2 }, (_, tile) => (
          <button
            key={tile}
            type="button"
            disabled={disabled || phase !== "input" || wonRef.current}
            onClick={() => chooseTile(tile)}
            aria-label={`Pattern tile ${tileName(tile, config.size)}`}
            className={cn(
              "aspect-square rounded-xl border border-border bg-card outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              activeTile === tile && "border-primary bg-primary/25 ring-2 ring-primary/40",
              phase === "input" && "hover:bg-muted",
              input[input.length - 1] === tile && "bg-primary/10",
            )}
          >
            <span className="mx-auto block size-3 rounded-full bg-primary/70" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="min-h-4 text-center text-[11px] text-muted-foreground" aria-live="polite">
        {activeTile === null ? message : `Showing ${tileName(activeTile, config.size)}`}
      </p>
    </div>
  );
}

"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";

import {
  advanceSnake,
  createSnakeGameState,
  type SnakeBlockReason,
  type SnakeDirection,
  type SnakeModifier,
} from "./extra-game-utils";
import type { MiniGameProps } from "./game-utils";

const KEY_DIRECTIONS: Record<string, SnakeDirection | undefined> = {
  ArrowUp: "N",
  w: "N",
  W: "N",
  ArrowRight: "E",
  d: "E",
  D: "E",
  ArrowDown: "S",
  s: "S",
  S: "S",
  ArrowLeft: "W",
  a: "W",
  A: "W",
};

const BLOCKED_MESSAGES: Record<SnakeBlockReason, string> = {
  wall: "That edge is closed. Try another direction.",
  self: "The trail is in the way. Turn another direction.",
  obstacle: "A block is in the way. Find a route around it.",
  order: "Collect the numbered targets in order.",
};

const DIRECTION_LABELS: Record<SnakeDirection, string> = {
  N: "up",
  E: "right",
  S: "down",
  W: "left",
};

function DirectionIcon({ direction }: { direction: SnakeDirection }) {
  const rotation = { N: 0, E: 90, S: 180, W: 270 }[direction];
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4"
      style={{ transform: `rotate(${rotation}deg)` }}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m5 12 5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[62%]" fill="none" aria-hidden="true">
      <circle cx="12" cy="13" r="6.5" fill="currentColor" opacity=".2" />
      <circle cx="12" cy="13" r="4" fill="currentColor" />
      <path d="M12 8c.2-2 1.4-3.2 3.4-3.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SnakeTrailGame({
  onWin,
  disabled = false,
  className,
  variantIndex = 0,
  modifierId = "compact",
}: MiniGameProps) {
  const [game, setGame] = useState(() =>
    createSnakeGameState(modifierId as SnakeModifier, variantIndex),
  );
  const gameRef = useRef(game);
  const wonRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const [message, setMessage] = useState("Use a direction to move one tile.");

  function move(direction: SnakeDirection) {
    if (disabled || wonRef.current) return;
    const result = advanceSnake(gameRef.current, direction);
    if (result.event === "blocked") {
      setMessage(BLOCKED_MESSAGES[result.reason ?? "wall"]);
      return;
    }

    gameRef.current = result.state;
    setGame(result.state);
    if (result.event === "collected") {
      setMessage(`Target ${result.state.targetIndex} collected. Keep going.`);
    } else if (result.event === "won") {
      wonRef.current = true;
      setMessage("All targets collected.");
      window.setTimeout(() => onWin?.(), 0);
    } else {
      setMessage("Trail moved one tile.");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const direction = KEY_DIRECTIONS[event.key];
    if (!direction) return;
    event.preventDefault();
    move(direction);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled || wonRef.current) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || disabled || wonRef.current) return;
    const horizontalDistance = event.clientX - start.x;
    const verticalDistance = event.clientY - start.y;
    if (Math.max(Math.abs(horizontalDistance), Math.abs(verticalDistance)) < 18) return;
    if (Math.abs(horizontalDistance) > Math.abs(verticalDistance)) {
      move(horizontalDistance > 0 ? "E" : "W");
    } else {
      move(verticalDistance > 0 ? "S" : "N");
    }
  }

  const visibleTargets = game.ordered
    ? game.targets.map((cellIndex, index) => ({ cellIndex, index }))
    : game.targetIndex < game.targets.length
      ? [{ cellIndex: game.targets[game.targetIndex], index: game.targetIndex }]
      : [];

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        Use arrow keys, WASD, a swipe, or the controls. Each input moves one tile. Collect the green targets one by one—the trail grows with each target, while blocked moves simply let you choose another direction.
      </p>

      <div
        role="group"
        aria-label={`Snake Trail, ${game.size} by ${game.size} grid`}
        tabIndex={disabled || wonRef.current ? -1 : 0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          pointerStartRef.current = null;
        }}
        className="mx-auto grid aspect-square w-full max-w-[288px] touch-none gap-1 rounded-xl border border-border bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ gridTemplateColumns: `repeat(${game.size}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: game.size * game.size }, (_, cellIndex) => {
          const snakeIndex = game.snake.indexOf(cellIndex);
          const target = visibleTargets.find((item) => item.cellIndex === cellIndex);
          const isCurrentTarget = target?.index === game.targetIndex;
          const isObstacle = game.obstacles.includes(cellIndex);

          return (
            <div
              key={cellIndex}
              className={cn(
                "relative flex aspect-square items-center justify-center overflow-hidden rounded-[5px] border border-border/60 bg-muted/25",
                isObstacle && "border-muted-foreground/25 bg-muted",
                target && "border-success/45 bg-success/10 text-success",
                snakeIndex > 0 && "border-primary/35 bg-primary/35",
                snakeIndex === 0 && "border-primary bg-primary text-primary-foreground",
              )}
              aria-hidden="true"
            >
              {isObstacle ? (
                <svg viewBox="0 0 24 24" className="size-full text-muted-foreground/30">
                  <path d="m-3 5 8-8M0 14 14 0M6 24 24 6M15 27l12-12" stroke="currentColor" strokeWidth="3" />
                </svg>
              ) : null}
              {target && snakeIndex < 0 ? (
                game.ordered ? (
                  <span
                    className={cn(
                      "flex size-[70%] items-center justify-center rounded-full border text-[10px] font-semibold",
                      isCurrentTarget
                        ? "border-success bg-success text-success-foreground"
                        : "border-success/40 bg-background text-success",
                    )}
                  >
                    {target.index + 1}
                  </span>
                ) : (
                  <TargetIcon />
                )
              ) : null}
              {snakeIndex === 0 ? (
                <span className="flex gap-[3px]">
                  <span className="size-1 rounded-full bg-primary-foreground" />
                  <span className="size-1 rounded-full bg-primary-foreground" />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mx-auto grid w-fit grid-cols-3 gap-1" aria-label="Snake direction controls">
        <span />
        <button
          type="button"
          onClick={() => move("N")}
          disabled={disabled || wonRef.current}
          aria-label="Move up"
          className="flex size-8 items-center justify-center rounded-md border border-border bg-card text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <DirectionIcon direction="N" />
        </button>
        <span />
        {(["W", "S", "E"] as SnakeDirection[]).map((direction) => (
          <button
            key={direction}
            type="button"
            onClick={() => move(direction)}
            disabled={disabled || wonRef.current}
            aria-label={`Move ${DIRECTION_LABELS[direction]}`}
            className="flex size-8 items-center justify-center rounded-md border border-border bg-card text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <DirectionIcon direction={direction} />
          </button>
        ))}
      </div>

      <div className="text-center text-[11px] text-muted-foreground">
        <p>{game.targetIndex} of {game.targets.length} targets collected · Trail length {game.snake.length}</p>
        <p className="min-h-4" aria-live="polite">{message}</p>
      </div>
    </div>
  );
}

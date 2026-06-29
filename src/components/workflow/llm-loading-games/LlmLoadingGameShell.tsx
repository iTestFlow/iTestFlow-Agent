"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { LoadingGameChoice } from "./game-utils";
import { LOADING_GAME_CATALOG, modifierFor } from "./game-catalog";
import type { LlmLoadingGamePanelController } from "./use-llm-loading-game-session";

function GamepadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7.2 8.2h9.6c2 0 3.5 1.3 4 3.2l.8 3.3c.7 2.7-2.5 4.5-4.3 2.4l-1.2-1.4H7.9l-1.2 1.4c-1.8 2.1-5-.3-4.3-2.9l.8-2.8c.5-1.9 2-3.2 4-3.2Z" />
      <path d="M7 11v3M5.5 12.5h3M16.8 11.5h.01M18.5 13.2h.01" strokeLinecap="round" />
    </svg>
  );
}

function NextGameIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 7h3.5c4.5 0 4.5 10 9 10H20M17 14l3 3-3 3M4 17h3.5c1.5 0 2.5-1.1 3.4-2.5M14 9.5c.7-1.4 1.5-2.5 2.5-2.5H20M17 4l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export type LlmLoadingGameLabels = {
  playLabel: string;
  readyLabel: string;
  viewResponseLabel: string;
  keepPlayingLabel: string;
  closeGameLabel: string;
};

export type LlmLoadingGameShellProps = {
  isLoading: boolean;
  isReady?: boolean;
  controller: LlmLoadingGamePanelController;
  game?: LoadingGameChoice;
  labels?: Partial<LlmLoadingGameLabels>;
  className?: string;
};

const DEFAULT_LABELS: LlmLoadingGameLabels = {
  playLabel: "Play while waiting?",
  readyLabel: "Response is ready.",
  viewResponseLabel: "View Response",
  keepPlayingLabel: "Keep Playing",
  closeGameLabel: "Close Game",
};

export function LlmLoadingGameShell({
  isLoading,
  isReady = false,
  controller,
  game,
  labels,
  className,
}: LlmLoadingGameShellProps) {
  const resolvedLabels = { ...DEFAULT_LABELS, ...labels };

  if (!controller.isGameOpen) {
    if (!isLoading) return null;
    return (
      <div className={cn("flex justify-center", className)}>
        <Button
          type="button"
          size="sm"
          onClick={() => controller.openGame(game)}
          className="rounded-full border border-primary/30 bg-gradient-to-r from-primary to-info px-3.5 text-white shadow-sm shadow-primary/20 hover:opacity-90 focus-visible:ring-primary/40 dark:border-primary/40"
        >
          <GamepadIcon />
          {resolvedLabels.playLabel}
        </Button>
      </div>
    );
  }

  const ready = isReady || controller.isResponseReady;
  const selectedGame = controller.selectedGame;
  if (!selectedGame) return null;
  const definition = LOADING_GAME_CATALOG[selectedGame];
  const modifier = modifierFor(selectedGame, controller.selectedModifier);
  const GameComponent = definition.component;

  return (
    <section
      key={controller.sessionKey}
      className={cn("mx-auto w-full max-w-[320px] space-y-3 rounded-xl border border-border bg-muted/30 p-3", className)}
      aria-label="Optional waiting game"
    >
      <div className="space-y-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{definition.title}</p>
          <p className="text-[11px] text-muted-foreground">{definition.instructions}</p>
        </div>
        <div className="flex items-center justify-end gap-1">
          <Button type="button" variant="outline" size="xs" onClick={controller.nextGame}>
            <NextGameIcon />
            Next Game
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={controller.closeGame}>
            {resolvedLabels.closeGameLabel}
          </Button>
        </div>
      </div>

      {modifier ? (
        <div className="rounded-lg border border-info/25 bg-info/10 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-info">Twist: {modifier.label}</p>
          <p className="text-[11px] leading-4 text-muted-foreground">{modifier.description}</p>
        </div>
      ) : null}

      {ready && !controller.isGameSolved ? (
        <div className="space-y-2 rounded-lg border border-success/30 bg-success/10 p-2.5" role="status" aria-live="polite">
          <p className="text-sm font-medium text-foreground">{resolvedLabels.readyLabel}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={controller.viewResponse}>
              {resolvedLabels.viewResponseLabel}
            </Button>
            {!controller.keptPlaying ? (
              <Button type="button" variant="outline" size="sm" onClick={controller.keepPlaying}>
                {resolvedLabels.keepPlayingLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {controller.isGameSolved ? (
        <div className="space-y-1 rounded-lg border border-success/30 bg-success/10 p-3" role="status" aria-live="polite">
          <p className="text-sm font-medium text-foreground">Nice! Puzzle solved.</p>
          <p className="text-xs text-muted-foreground">
            {ready ? "Your response is ready." : "Your AI result is still being prepared."}
          </p>
          {ready ? (
            <Button type="button" size="sm" className="mt-1" onClick={controller.viewResponse}>
              {resolvedLabels.viewResponseLabel}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={controller.nextGame}>
              <NextGameIcon />
              Play another game
            </Button>
          )}
        </div>
      ) : (
        <GameComponent
          key={`${controller.sessionKey}-${controller.gameRoundKey}`}
          variantIndex={controller.selectedVariant ?? undefined}
          modifierId={controller.selectedModifier ?? undefined}
          onWin={controller.markSolved}
          disabled={controller.isGameSolved}
        />
      )}
    </section>
  );
}

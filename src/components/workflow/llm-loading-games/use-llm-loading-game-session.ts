"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LoadingGameChoice, LoadingGameName } from "./game-utils";
import { drawFromShuffleBag } from "./game-utils";
import { LOADING_GAME_DEFINITIONS, LOADING_GAME_NAMES } from "./game-definitions";

export type LoadingGameState = {
  sessionKey: number;
  gameRoundKey: number;
  isGameOpen: boolean;
  selectedGame: LoadingGameName | null;
  selectedVariant: number | null;
  selectedModifier: string | null;
  hasGameStarted: boolean;
  isGameSolved: boolean;
  isResponseReady: boolean;
  keptPlaying: boolean;
};

export type LoadingGameAction =
  | { type: "START_SESSION" }
  | { type: "OPEN_GAME"; game: LoadingGameName; variant: number; modifier: string }
  | { type: "SOLVED" }
  | { type: "RESPONSE_READY" }
  | { type: "KEEP_PLAYING" }
  | { type: "CLOSE_GAME" }
  | { type: "END_SESSION" };

export const INITIAL_LOADING_GAME_STATE: LoadingGameState = {
  sessionKey: 0,
  gameRoundKey: 0,
  isGameOpen: false,
  selectedGame: null,
  selectedVariant: null,
  selectedModifier: null,
  hasGameStarted: false,
  isGameSolved: false,
  isResponseReady: false,
  keptPlaying: false,
};

export function loadingGameReducer(state: LoadingGameState, action: LoadingGameAction): LoadingGameState {
  switch (action.type) {
    case "START_SESSION":
      return { ...INITIAL_LOADING_GAME_STATE, sessionKey: state.sessionKey + 1 };
    case "OPEN_GAME":
      return {
        ...state,
        gameRoundKey: state.gameRoundKey + 1,
        isGameOpen: true,
        selectedGame: action.game,
        selectedVariant: action.variant,
        selectedModifier: action.modifier,
        hasGameStarted: true,
        isGameSolved: false,
      };
    case "SOLVED":
      return { ...state, isGameSolved: true };
    case "RESPONSE_READY":
      return { ...state, isResponseReady: true };
    case "KEEP_PLAYING":
      return { ...state, keptPlaying: true };
    case "CLOSE_GAME":
      return {
        ...state,
        isGameOpen: false,
        selectedGame: null,
        selectedVariant: null,
        selectedModifier: null,
        hasGameStarted: false,
        isGameSolved: false,
        isResponseReady: false,
        keptPlaying: false,
      };
    case "END_SESSION":
      return { ...INITIAL_LOADING_GAME_STATE, sessionKey: state.sessionKey };
  }
}

export function shouldDeferLoadingGameResult(state: LoadingGameState): boolean {
  return state.isGameOpen;
}

export type LlmLoadingGamePanelController = LoadingGameState & {
  openGame: (game?: LoadingGameChoice) => void;
  nextGame: () => void;
  closeGame: () => void;
  keepPlaying: () => void;
  viewResponse: () => void;
  markSolved: () => void;
};

export type LlmLoadingGameSession<T> = {
  panel: LlmLoadingGamePanelController;
  shouldKeepPanelMounted: boolean;
  startSession: () => void;
  completeSession: (result: T) => void;
  endSession: () => void;
};

function loadingGameRecord<T>(createValue: () => T): Record<LoadingGameName, T> {
  return LOADING_GAME_NAMES.reduce((record, name) => {
    record[name] = createValue();
    return record;
  }, {} as Record<LoadingGameName, T>);
}

export function useLlmLoadingGameSession<T>(
  onReveal: (result: T) => void,
  game: LoadingGameChoice = "random",
): LlmLoadingGameSession<T> {
  const [state, setState] = useState(INITIAL_LOADING_GAME_STATE);
  const stateRef = useRef(state);
  const pendingResultRef = useRef<T | null>(null);
  const onRevealRef = useRef(onReveal);
  const gameBagRef = useRef<LoadingGameName[]>([]);
  const previousGameRef = useRef<LoadingGameName | null>(null);
  const variantBagRef = useRef(loadingGameRecord<number[]>(() => []));
  const previousVariantRef = useRef(loadingGameRecord<number | null>(() => null));
  const modifierBagRef = useRef(loadingGameRecord<string[]>(() => []));
  const previousModifierRef = useRef(loadingGameRecord<string | null>(() => null));

  useEffect(() => {
    onRevealRef.current = onReveal;
  }, [onReveal]);

  const update = useCallback((action: LoadingGameAction) => {
    setState((current) => {
      const next = loadingGameReducer(current, action);
      stateRef.current = next;
      return next;
    });
  }, []);

  const revealPendingResult = useCallback(() => {
    const result = pendingResultRef.current;
    pendingResultRef.current = null;
    if (result !== null) onRevealRef.current(result);
  }, []);

  const startSession = useCallback(() => {
    pendingResultRef.current = null;
    update({ type: "START_SESSION" });
  }, [update]);

  const completeSession = useCallback((result: T) => {
    if (shouldDeferLoadingGameResult(stateRef.current)) {
      pendingResultRef.current = result;
      update({ type: "RESPONSE_READY" });
      return;
    }
    onRevealRef.current(result);
  }, [update]);

  const endSession = useCallback(() => {
    pendingResultRef.current = null;
    update({ type: "END_SESSION" });
  }, [update]);

  const openGame = useCallback((overrideGame: LoadingGameChoice = game) => {
    let selectedGame: LoadingGameName;
    if (overrideGame === "random") {
      const gameDraw = drawFromShuffleBag<LoadingGameName>(
        LOADING_GAME_NAMES,
        gameBagRef.current,
        previousGameRef.current,
      );
      selectedGame = gameDraw.value;
      gameBagRef.current = gameDraw.remaining;
    } else {
      selectedGame = overrideGame;
    }
    previousGameRef.current = selectedGame;

    const definition = LOADING_GAME_DEFINITIONS[selectedGame];
    const variantCount = definition.variantCount;
    const variantDraw = drawFromShuffleBag(
      Array.from({ length: variantCount }, (_, index) => index),
      variantBagRef.current[selectedGame],
      previousVariantRef.current[selectedGame],
    );
    variantBagRef.current[selectedGame] = variantDraw.remaining;
    previousVariantRef.current[selectedGame] = variantDraw.value;

    const modifierDraw = drawFromShuffleBag(
      definition.modifiers.map((modifier) => modifier.id),
      modifierBagRef.current[selectedGame],
      previousModifierRef.current[selectedGame],
    );
    modifierBagRef.current[selectedGame] = modifierDraw.remaining;
    previousModifierRef.current[selectedGame] = modifierDraw.value;
    update({
      type: "OPEN_GAME",
      game: selectedGame,
      variant: variantDraw.value,
      modifier: modifierDraw.value,
    });
  }, [game, update]);

  const nextGame = useCallback(() => openGame("random"), [openGame]);
  const closeGame = useCallback(() => {
    const responseReady = stateRef.current.isResponseReady;
    update({ type: "CLOSE_GAME" });
    if (responseReady) revealPendingResult();
  }, [revealPendingResult, update]);

  const viewResponse = useCallback(() => {
    update({ type: "CLOSE_GAME" });
    revealPendingResult();
  }, [revealPendingResult, update]);

  const keepPlaying = useCallback(() => update({ type: "KEEP_PLAYING" }), [update]);
  const markSolved = useCallback(() => update({ type: "SOLVED" }), [update]);

  useEffect(() => {
    return () => {
      pendingResultRef.current = null;
    };
  }, []);

  const panel = useMemo<LlmLoadingGamePanelController>(() => ({
    ...state,
    openGame,
    nextGame,
    closeGame,
    keepPlaying,
    viewResponse,
    markSolved,
  }), [closeGame, keepPlaying, markSolved, nextGame, openGame, state, viewResponse]);

  return {
    panel,
    shouldKeepPanelMounted: state.isGameOpen,
    startSession,
    completeSession,
    endSession,
  };
}

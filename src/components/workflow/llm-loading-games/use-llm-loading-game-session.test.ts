import { describe, expect, it } from "vitest";

import {
  INITIAL_LOADING_GAME_STATE,
  loadingGameReducer,
  shouldDeferLoadingGameResult,
} from "./use-llm-loading-game-session";

describe("loading game session state", () => {
  it("does not open automatically and does not defer unopened results", () => {
    const started = loadingGameReducer(INITIAL_LOADING_GAME_STATE, { type: "START_SESSION" });
    expect(started).toMatchObject({
      sessionKey: 1,
      isGameOpen: false,
      selectedGame: null,
      isResponseReady: false,
    });
    expect(shouldDeferLoadingGameResult(started)).toBe(false);
  });

  it("opens a selected game and defers a ready response", () => {
    const opened = loadingGameReducer(INITIAL_LOADING_GAME_STATE, { type: "OPEN_GAME", game: "zip", variant: 1, modifier: "guided" });
    const ready = loadingGameReducer(opened, { type: "RESPONSE_READY" });
    expect(shouldDeferLoadingGameResult(ready)).toBe(true);
    expect(ready).toMatchObject({
      isGameOpen: true,
      selectedGame: "zip",
      selectedVariant: 1,
      selectedModifier: "guided",
      isResponseReady: true,
    });
  });

  it("keeps the ready notification while playing", () => {
    const opened = loadingGameReducer(INITIAL_LOADING_GAME_STATE, { type: "OPEN_GAME", game: "pipe", variant: 2, modifier: "leaks" });
    const ready = loadingGameReducer(opened, { type: "RESPONSE_READY" });
    const kept = loadingGameReducer(ready, { type: "KEEP_PLAYING" });
    expect(kept).toMatchObject({
      isGameOpen: true,
      isResponseReady: true,
      keptPlaying: true,
    });
  });

  it("tracks solving before and after response readiness", () => {
    const opened = loadingGameReducer(INITIAL_LOADING_GAME_STATE, { type: "OPEN_GAME", game: "zip", variant: 0, modifier: "reverse" });
    const solvedWhileLoading = loadingGameReducer(opened, { type: "SOLVED" });
    expect(solvedWhileLoading.isGameSolved).toBe(true);
    expect(solvedWhileLoading.isResponseReady).toBe(false);

    const solvedAfterReady = loadingGameReducer(
      loadingGameReducer(opened, { type: "RESPONSE_READY" }),
      { type: "SOLVED" },
    );
    expect(solvedAfterReady.isGameSolved).toBe(true);
    expect(solvedAfterReady.isResponseReady).toBe(true);
  });

  it("starts a fresh puzzle round when the user plays again", () => {
    const opened = loadingGameReducer(INITIAL_LOADING_GAME_STATE, {
      type: "OPEN_GAME",
      game: "pipe",
      variant: 0,
      modifier: "locked",
    });
    const solved = loadingGameReducer(opened, { type: "SOLVED" });
    const replayed = loadingGameReducer(solved, {
      type: "OPEN_GAME",
      game: "zip",
      variant: 2,
      modifier: "compact",
    });

    expect(replayed).toMatchObject({
      gameRoundKey: 2,
      selectedGame: "zip",
      selectedVariant: 2,
      selectedModifier: "compact",
      isGameSolved: false,
      isResponseReady: false,
    });
  });

  it("preserves response-ready and Keep Playing state across Next Game", () => {
    const opened = loadingGameReducer(INITIAL_LOADING_GAME_STATE, {
      type: "OPEN_GAME",
      game: "memory",
      variant: 1,
      modifier: "six-pairs",
    });
    const ready = loadingGameReducer(opened, { type: "RESPONSE_READY" });
    const kept = loadingGameReducer(ready, { type: "KEEP_PLAYING" });
    const switched = loadingGameReducer(kept, {
      type: "OPEN_GAME",
      game: "lights",
      variant: 4,
      modifier: "diagonal",
    });

    expect(switched).toMatchObject({
      selectedGame: "lights",
      selectedModifier: "diagonal",
      isGameSolved: false,
      isResponseReady: true,
      keptPlaying: true,
    });
  });

  it("closes cleanly and resets for a new run", () => {
    const opened = loadingGameReducer(INITIAL_LOADING_GAME_STATE, { type: "OPEN_GAME", game: "pipe", variant: 1, modifier: "counter" });
    const closed = loadingGameReducer(opened, { type: "CLOSE_GAME" });
    expect(closed).toMatchObject({
      isGameOpen: false,
      selectedGame: null,
      selectedVariant: null,
      selectedModifier: null,
      isGameSolved: false,
      isResponseReady: false,
    });

    const restarted = loadingGameReducer(closed, { type: "START_SESSION" });
    expect(restarted.sessionKey).toBe(1);
    expect(restarted.hasGameStarted).toBe(false);
  });

  it("ends cancelled sessions without incrementing their identity", () => {
    const started = loadingGameReducer(INITIAL_LOADING_GAME_STATE, { type: "START_SESSION" });
    const opened = loadingGameReducer(started, { type: "OPEN_GAME", game: "zip", variant: 2, modifier: "extended" });
    const ended = loadingGameReducer(opened, { type: "END_SESSION" });
    expect(ended).toEqual({ ...INITIAL_LOADING_GAME_STATE, sessionKey: 1 });
  });
});

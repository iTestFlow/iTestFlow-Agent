"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TokenUsage } from "@/modules/llm/llm-types";
import { ApiError } from "@/components/workflow/api-error";
import type { AppErrorCode, ErrorTechnicalContext } from "@/modules/shared/errors/app-error";
import { caughtErrorMessage } from "@/shared/lib/api-error-message";

/* --------------------------------------------------------------------------
 * Driver hook for the AI generation progress experience.
 *
 * The backend does not stream — every generation is a single blocking POST
 * that returns the full JSON at the end. This hook drives an honest client-side
 * status machine so long waits feel intentional: the front steps advance on a
 * short timer (they genuinely are the quick front-loaded work), it dwells on
 * "waiting_llm" for the bulk of the wait with a live elapsed timer, then flips
 * to "validating_response" the instant the real response arrives and is parsed.
 *
 * No AI content is ever fabricated here — only pipeline status. Cancellation is
 * real: the AbortController aborts the in-flight fetch (the server keeps running
 * but its result is discarded).
 * ------------------------------------------------------------------------ */

export type AiGenerationStatus =
  | "idle"
  | "preparing_context"
  | "building_prompt"
  | "sending_request"
  | "waiting_llm"
  | "streaming" /* reserved — no streaming backend today */
  | "validating_response"
  | "completed"
  | "failed"
  | "cancelled";

export type UseAiGenerationOptions = {
  /** ms spent on "preparing_context" before advancing. */
  prepareMs?: number;
  /** ms spent on "building_prompt" before advancing. */
  buildPromptMs?: number;
  /** ms spent on "sending_request" before advancing to "waiting_llm". */
  sendMs?: number;
  /** Minimum dwell on "validating_response" so it reads as a real step. */
  validateMinMs?: number;
};

export type AiGenerationError = {
  message: string;
  code?: AppErrorCode;
  technicalDetails?: string;
  technicalContext?: ErrorTechnicalContext;
};

export type AiGenerationController = {
  status: AiGenerationStatus;
  elapsedSeconds: number;
  tokenUsage?: TokenUsage;
  /** Non-blocking warnings from the request (e.g. the response was truncated at the token cap). */
  warnings?: string[];
  /** true while a request is in flight (not idle/completed/failed/cancelled). */
  isRunning: boolean;
  error: AiGenerationError | null;
  errorMessage: string | null;
  /**
   * Run a request through the staged status machine. Resolves with the request
   * value on success, or `undefined` if it failed or was cancelled (in which
   * case `status`/`errorMessage` describe what happened — the caller should
   * branch on `data === undefined`).
   */
  start: <T>(request: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
  /** Abort the in-flight request and move to the "cancelled" state. */
  cancel: () => void;
  /** Reset to idle (used before the caller re-invokes its handler). */
  retry: () => void;
  /** Reset to idle and clear all timers/controllers. */
  reset: () => void;
};

const DEFAULTS: Required<UseAiGenerationOptions> = {
  prepareMs: 450,
  buildPromptMs: 550,
  sendMs: 350,
  validateMinMs: 400,
};

const TERMINAL: ReadonlySet<AiGenerationStatus> = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
]);

function errorFrom(error: unknown): AiGenerationError {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      code: error.code,
      technicalDetails: error.technicalDetails,
      technicalContext: error.technicalContext,
    };
  }
  return {
    message: caughtErrorMessage(error, "Generation failed."),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const id = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(id);
      resolve();
    }, { once: true });
  });
}

export function useAiGeneration(options?: UseAiGenerationOptions): AiGenerationController {
  const config = { ...DEFAULTS, ...options };
  const [status, setStatus] = useState<AiGenerationStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[] | undefined>(undefined);
  const [error, setError] = useState<AiGenerationError | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const stageTimeoutsRef = useRef<number[]>([]);
  const startedAtRef = useRef<number>(0);

  const clearStageTimeouts = useCallback(() => {
    for (const id of stageTimeoutsRef.current) window.clearTimeout(id);
    stageTimeoutsRef.current = [];
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearStageTimeouts();
    stopTimer();
    setStatus("idle");
    setElapsedSeconds(0);
    setTokenUsage(undefined);
    setWarnings(undefined);
    setError(null);
  }, [clearStageTimeouts, stopTimer]);

  const start = useCallback(
    async <T,>(request: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
      // Tear down any prior run before starting a fresh one.
      abortRef.current?.abort();
      clearStageTimeouts();
      stopTimer();

      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setError(null);
      setElapsedSeconds(0);
      setTokenUsage(undefined);
      setWarnings(undefined);
      startedAtRef.current = Date.now();
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 1000);

      setStatus("preparing_context");
      // Front steps advance on a short timer (they are genuinely the quick
      // front-loaded work). Each transition is guarded against abort.
      const schedule = (atMs: number, next: AiGenerationStatus) => {
        const id = window.setTimeout(() => {
          if (!signal.aborted) setStatus(next);
        }, atMs);
        stageTimeoutsRef.current.push(id);
      };
      const buildAt = config.prepareMs;
      const sendAt = buildAt + config.buildPromptMs;
      const waitAt = sendAt + config.sendMs;
      schedule(buildAt, "building_prompt");
      schedule(sendAt, "sending_request");
      schedule(waitAt, "waiting_llm");

      try {
        const data = await request(signal);
        // Real response arrived — stop faking forward progress.
        clearStageTimeouts();
        if (signal.aborted) {
          stopTimer();
          setStatus("cancelled");
          return undefined;
        }
        setStatus("validating_response");
        await delay(config.validateMinMs, signal);
        const finalElapsedSeconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
        stopTimer();
        if (signal.aborted) {
          setStatus("cancelled");
          return undefined;
        }
        setElapsedSeconds(finalElapsedSeconds);
        setTokenUsage(extractTokenUsage(data));
        setWarnings(extractWarnings(data));
        setStatus("completed");
        return data;
      } catch (caughtError) {
        clearStageTimeouts();
        stopTimer();
        if (isAbortError(caughtError) || signal.aborted) {
          setStatus("cancelled");
          return undefined;
        }
        setError(errorFrom(caughtError));
        setStatus("failed");
        return undefined;
      }
    },
    [clearStageTimeouts, stopTimer, config.prepareMs, config.buildPromptMs, config.sendMs, config.validateMinMs],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    clearStageTimeouts();
  }, [clearStageTimeouts]);

  const retry = useCallback(() => {
    reset();
  }, [reset]);

  // Abort the fetch + clear timers on unmount (navigate-away mid-request).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      for (const id of stageTimeoutsRef.current) window.clearTimeout(id);
      stageTimeoutsRef.current = [];
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  return {
    status,
    elapsedSeconds,
    tokenUsage,
    warnings,
    isRunning: !TERMINAL.has(status),
    error,
    errorMessage: error?.message ?? null,
    start,
    cancel,
    retry,
    reset,
  };
}

function extractTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || !("tokenUsage" in value)) return undefined;
  const usage = (value as { tokenUsage?: unknown }).tokenUsage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const input = validCount(record.input);
  const output = validCount(record.output);
  const total = validCount(record.total);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { input, output, total };
}

function validCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractWarnings(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || !("warnings" in value)) return undefined;
  const warnings = (value as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return undefined;
  const messages = warnings.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return messages.length ? messages : undefined;
}

/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./api-error";
import { useAiGeneration } from "./use-ai-generation";
import { AppErrorCode } from "@/modules/shared/errors/app-error";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fetch-like request: rejects with an AbortError the moment the signal aborts. */
function abortableRequest<T>(gate: ReturnType<typeof deferred<T>>) {
  const seen: { signal?: AbortSignal } = {};
  const request = (signal: AbortSignal) => {
    seen.signal = signal;
    signal.addEventListener(
      "abort",
      () => gate.reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
    return gate.promise;
  };
  return { request, seen };
}

describe("useAiGeneration", () => {
  it("advances through the front stages at the configured offsets and ticks elapsed seconds", async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    const { result } = renderHook(() =>
      useAiGeneration({ prepareMs: 100, buildPromptMs: 200, sendMs: 300, validateMinMs: 400 }),
    );
    expect(result.current.status).toBe("idle");
    expect(result.current.isRunning).toBe(false);

    act(() => {
      void result.current.start(() => gate.promise);
    });
    // start() is synchronous up to the request await: the first stage is immediate.
    expect(result.current.status).toBe("preparing_context");
    expect(result.current.isRunning).toBe(true);

    // Each transition happens exactly at its cumulative offset, not a tick before.
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(result.current.status).toBe("preparing_context");
    await act(async () => vi.advanceTimersByTimeAsync(1)); // t=100
    expect(result.current.status).toBe("building_prompt");
    await act(async () => vi.advanceTimersByTimeAsync(199)); // t=299
    expect(result.current.status).toBe("building_prompt");
    await act(async () => vi.advanceTimersByTimeAsync(1)); // t=300
    expect(result.current.status).toBe("sending_request");
    await act(async () => vi.advanceTimersByTimeAsync(300)); // t=600
    expect(result.current.status).toBe("waiting_llm");

    // No fabricated progress past waiting_llm — only the 1s elapsed counter runs.
    await act(async () => vi.advanceTimersByTimeAsync(2400)); // t=3000
    expect(result.current.status).toBe("waiting_llm");
    expect(result.current.elapsedSeconds).toBe(3);
  });

  it("uses the default stage offsets (450 / 1000 / 1350 ms)", async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    const { result } = renderHook(() => useAiGeneration());
    act(() => {
      void result.current.start(() => gate.promise);
    });
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(result.current.status).toBe("building_prompt");
    await act(async () => vi.advanceTimersByTimeAsync(550)); // t=1000
    expect(result.current.status).toBe("sending_request");
    await act(async () => vi.advanceTimersByTimeAsync(350)); // t=1350
    expect(result.current.status).toBe("waiting_llm");
  });

  it("validates on resolve, dwells validateMinMs, then completes with usage metadata and the data", async () => {
    vi.useFakeTimers();
    const payload = {
      cases: ["tc-1"],
      tokenUsage: { input: 5, output: 7, total: 12 },
      warnings: ["Response was truncated at the token cap."],
    };
    const gate = deferred<typeof payload>();
    const { result } = renderHook(() =>
      useAiGeneration({ prepareMs: 100, buildPromptMs: 100, sendMs: 100, validateMinMs: 400 }),
    );
    let startPromise!: Promise<typeof payload | undefined>;
    act(() => {
      startPromise = result.current.start(() => gate.promise);
    });
    await act(async () => vi.advanceTimersByTimeAsync(2600));
    expect(result.current.status).toBe("waiting_llm");

    // The instant the response lands the machine stops faking forward progress.
    await act(async () => {
      gate.resolve(payload);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("validating_response");

    // Validation dwells the configured minimum even though the data is already parsed.
    await act(async () => vi.advanceTimersByTimeAsync(399));
    expect(result.current.status).toBe("validating_response");
    await act(async () => vi.advanceTimersByTimeAsync(1)); // t=3000
    expect(result.current.status).toBe("completed");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.tokenUsage).toEqual({ input: 5, output: 7, total: 12 });
    expect(result.current.warnings).toEqual(["Response was truncated at the token cap."]);
    expect(result.current.elapsedSeconds).toBe(3);
    expect(result.current.error).toBeNull();
    await expect(startPromise).resolves.toBe(payload);
    // Interval, stage timers, and the validate dwell are all torn down.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores malformed tokenUsage/warnings metadata and keeps only valid entries", async () => {
    vi.useFakeTimers();
    const completeWith = async (data: unknown) => {
      const gate = deferred<unknown>();
      const { result } = renderHook(() => useAiGeneration({ validateMinMs: 1 }));
      act(() => {
        void result.current.start(() => gate.promise);
      });
      await act(async () => {
        gate.resolve(data);
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.status).toBe("completed");
      return result;
    };

    // Non-object payloads carry no metadata.
    const primitive = await completeWith("raw text");
    expect(primitive.current.tokenUsage).toBeUndefined();
    expect(primitive.current.warnings).toBeUndefined();

    // Negative, non-numeric, and NaN counts are all rejected; blank/non-string warnings drop.
    const malformed = await completeWith({
      tokenUsage: { input: -1, output: "12", total: Number.NaN },
      warnings: ["   ", "", 42],
    });
    expect(malformed.current.tokenUsage).toBeUndefined();
    expect(malformed.current.warnings).toBeUndefined();

    // A single valid count is enough; valid warnings survive the blank filter.
    const partial = await completeWith({
      tokenUsage: { output: 128 },
      warnings: ["Truncated.", "  ", "Retried once."],
    });
    expect(partial.current.tokenUsage).toEqual({ output: 128 });
    expect(partial.current.warnings).toEqual(["Truncated.", "Retried once."]);
  });

  it("cancel() aborts the in-flight request, lands in cancelled, and leaks no timers", async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    const { request, seen } = abortableRequest(gate);
    const { result } = renderHook(() => useAiGeneration());
    let startPromise!: Promise<unknown | undefined>;
    act(() => {
      startPromise = result.current.start(request);
    });
    await act(async () => vi.advanceTimersByTimeAsync(1350));
    expect(result.current.status).toBe("waiting_llm");
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the elapsed interval is live

    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });
    expect(seen.signal?.aborted).toBe(true);
    expect(result.current.status).toBe("cancelled");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toBeNull();
    await expect(startPromise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    // Terminal: nothing scheduled can flip the status later.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.status).toBe("cancelled");

    // retry() returns the machine to idle for the caller to re-invoke.
    act(() => {
      result.current.retry();
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.elapsedSeconds).toBe(0);
  });

  it("discards a response that lands after cancellation", async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    const { result } = renderHook(() => useAiGeneration());
    let startPromise!: Promise<unknown | undefined>;
    act(() => {
      // Request ignores the signal — resolves late, like a fetch that already left the socket.
      startPromise = result.current.start(() => gate.promise);
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(result.current.status).toBe("building_prompt");

    act(() => {
      result.current.cancel();
    });
    // Stage timers are dead immediately; status holds until the request settles.
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.status).toBe("building_prompt");

    await act(async () => {
      gate.resolve({ tokenUsage: { input: 1, output: 1, total: 2 } });
      await Promise.resolve();
    });
    expect(result.current.status).toBe("cancelled");
    expect(result.current.tokenUsage).toBeUndefined();
    await expect(startPromise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancelling during the validation dwell ends the dwell early and cancels", async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    const { result } = renderHook(() => useAiGeneration({ validateMinMs: 400 }));
    let startPromise!: Promise<unknown | undefined>;
    act(() => {
      startPromise = result.current.start(() => gate.promise);
    });
    await act(async () => {
      gate.resolve({ tokenUsage: { total: 9 } });
      await Promise.resolve();
    });
    expect(result.current.status).toBe("validating_response");

    // No timer advance needed: abort resolves the dwell immediately.
    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("cancelled");
    expect(result.current.tokenUsage).toBeUndefined();
    await expect(startPromise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps an ApiError rejection to failed with its message, code, and diagnostics", async () => {
    vi.useFakeTimers();
    const gate = deferred<never>();
    const { result } = renderHook(() => useAiGeneration());
    let startPromise!: Promise<unknown | undefined>;
    act(() => {
      startPromise = result.current.start(() => gate.promise);
    });
    await act(async () => {
      gate.reject(
        new ApiError("The model hit its token limit.", {
          status: 422,
          code: AppErrorCode.TokenLimit,
          technicalDetails: "finish_reason=length",
          technicalContext: { provider: "azure", model: "gpt-test" },
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.status).toBe("failed");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.errorMessage).toBe("The model hit its token limit.");
    expect(result.current.error).toEqual({
      message: "The model hit its token limit.",
      code: AppErrorCode.TokenLimit,
      technicalDetails: "finish_reason=length",
      technicalContext: { provider: "azure", model: "gpt-test" },
    });
    await expect(startPromise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps a non-Error rejection to the generic friendly message and retry() clears it", async () => {
    vi.useFakeTimers();
    const gate = deferred<never>();
    const { result } = renderHook(() => useAiGeneration());
    act(() => {
      void result.current.start(() => gate.promise);
    });
    await act(async () => {
      gate.reject("boom");
      await Promise.resolve();
    });
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toEqual({ message: "Generation failed." });
    expect(result.current.errorMessage).toBe("Generation failed.");

    act(() => {
      result.current.retry();
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it("unmounting mid-flight aborts the request and clears every timer", async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    const { request, seen } = abortableRequest(gate);
    const { result, unmount } = renderHook(() => useAiGeneration());
    act(() => {
      void result.current.start(request);
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(seen.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

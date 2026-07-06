/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAutoRefresh, type UseAutoRefreshOptions } from "./use-auto-refresh";

// Vitest globals are off, so RTL never registers its own cleanup; unmount explicitly so
// hooks from earlier tests cannot observe later visibilitychange dispatches.
afterEach(cleanup);

const T0 = 1_700_000_000_000;

function renderAutoRefresh(overrides: Partial<UseAutoRefreshOptions> = {}) {
  const onRefresh = vi.fn();
  const initialProps: UseAutoRefreshOptions = {
    enabled: true,
    intervalMs: 30_000,
    staleMs: 10_000,
    lastFetchAt: T0,
    suspended: false,
    onRefresh,
    ...overrides,
  };
  const utils = renderHook((props: UseAutoRefreshOptions) => useAutoRefresh(props), {
    initialProps,
  });
  return { ...utils, onRefresh, initialProps };
}

/** Makes document.visibilityState report `initial` until the returned setter changes it. */
function stubVisibility(initial: DocumentVisibilityState) {
  let state = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  return (next: DocumentVisibilityState) => {
    state = next;
  };
}

describe("useAutoRefresh", () => {
  it("fires onRefresh exactly once at lastFetchAt + intervalMs, re-arming only on a new anchor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { result, rerender, onRefresh, initialProps } = renderAutoRefresh();
    expect(result.current.nextRefreshAt).toBe(T0 + 30_000);
    expect(result.current.paused).toBe(false);

    // Fires exactly at anchor + interval, not a tick before.
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1)); // t = T0 + 30_000
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // One shot per anchor: recurrence only comes from the refresh producing a new lastFetchAt.
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // A completed fetch re-anchors the countdown at its own timestamp.
    const settledAt = T0 + 150_000; // == Date.now() after the advances above
    rerender({ ...initialProps, lastFetchAt: settledAt });
    expect(result.current.nextRefreshAt).toBe(settledAt + 30_000);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("clamps the delay to zero when the anchor is already past due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { result, onRefresh } = renderAutoRefresh({ lastFetchAt: T0 - 60_000 });
    // nextRefreshAt reports the anchor-based instant even when it is already in the past.
    expect(result.current.nextRefreshAt).toBe(T0 - 30_000);
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("schedules nothing when disabled, suspended, or before the first fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const cases: Partial<UseAutoRefreshOptions>[] = [
      { enabled: false },
      { suspended: true },
      { lastFetchAt: null },
    ];
    for (const overrides of cases) {
      const { result, onRefresh, unmount } = renderAutoRefresh(overrides);
      expect(result.current.nextRefreshAt).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => vi.advanceTimersByTimeAsync(600_000));
      expect(onRefresh).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("pauses instead of scheduling while the tab is hidden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    stubVisibility("hidden");
    const { result, onRefresh } = renderAutoRefresh();
    expect(result.current.paused).toBe(true);
    expect(result.current.nextRefreshAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("refreshes immediately on return to a visible tab once the data is staleMs old", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const setVisibility = stubVisibility("hidden");
    const { result, onRefresh } = renderAutoRefresh({
      lastFetchAt: T0 - 10_000, // age == staleMs exactly — the boundary is inclusive
      intervalMs: 60_000,
    });
    expect(result.current.paused).toBe(true);

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Fired synchronously by the event handler, before any timer advance.
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.paused).toBe(false);
    // The periodic schedule resumes against the same anchor (still 50s out) — the
    // immediate refresh does not double as the scheduled tick.
    expect(result.current.nextRefreshAt).toBe(T0 + 50_000);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on return to a visible tab while the data is still fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const setVisibility = stubVisibility("hidden");
    const { onRefresh } = renderAutoRefresh({
      lastFetchAt: T0 - 9_999, // one ms short of staleMs
      intervalMs: 60_000,
    });

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onRefresh).not.toHaveBeenCalled();

    // Becoming visible resumed the periodic timer, still anchored to lastFetchAt.
    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1)); // t = lastFetchAt + 60_000
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on return to a visible tab while suspended", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const setVisibility = stubVisibility("hidden");
    const { onRefresh } = renderAutoRefresh({ lastFetchAt: T0 - 60_000, suspended: true });

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onRefresh).not.toHaveBeenCalled();
    // Suspension also keeps the periodic timer un-armed after the tab is visible again.
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

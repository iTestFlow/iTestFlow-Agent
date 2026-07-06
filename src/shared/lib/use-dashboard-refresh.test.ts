/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDashboardRefresh, type UseDashboardRefreshOptions } from "./use-dashboard-refresh";

// Vitest globals are off, so RTL never registers its own cleanup.
afterEach(cleanup);

const T0 = 1_700_000_000_000;

function renderDashboardRefresh(overrides: Partial<UseDashboardRefreshOptions> = {}) {
  const onTrigger = vi.fn();
  const initialProps: UseDashboardRefreshOptions = {
    enabled: true,
    loading: false,
    intervalMs: 30_000,
    staleMs: 10_000,
    filterSettleMs: 5_000,
    onTrigger,
    ...overrides,
  };
  const utils = renderHook((props: UseDashboardRefreshOptions) => useDashboardRefresh(props), {
    initialProps,
  });
  return { ...utils, onTrigger, initialProps };
}

describe("useDashboardRefresh", () => {
  it("beginFetch reads and clears the background flag set by triggerRefresh(true)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { result, onTrigger } = renderDashboardRefresh();
    expect(result.current.refreshToken).toBe(0);
    expect(result.current.fetching).toBe(false);

    act(() => result.current.triggerRefresh(true));
    // onTrigger runs before the token bump so the caller can set bypass refs first.
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(true);
    expect(result.current.refreshToken).toBe(1); // drives the caller's fetch effect

    let first!: boolean;
    act(() => {
      first = result.current.beginFetch();
    });
    expect(first).toBe(true);
    expect(result.current.fetching).toBe(true); // quiet background refresh in flight

    // Read-and-clear: a second attempt for the same trigger is foreground.
    let second!: boolean;
    act(() => {
      second = result.current.beginFetch();
    });
    expect(second).toBe(false);
    expect(result.current.fetching).toBe(false);

    // A foreground trigger never marks the attempt as background.
    act(() => result.current.triggerRefresh(false));
    expect(onTrigger).toHaveBeenLastCalledWith(false);
    expect(result.current.refreshToken).toBe(2);
    let third!: boolean;
    act(() => {
      third = result.current.beginFetch();
    });
    expect(third).toBe(false);
  });

  it("settleFetch clears the quiet-refresh flag and anchors the next auto-refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { result, onTrigger, rerender, initialProps } = renderDashboardRefresh();
    // Nothing is scheduled before the first completed fetch.
    expect(result.current.nextRefreshAt).toBeNull();

    act(() => result.current.triggerRefresh(true));
    act(() => {
      result.current.beginFetch();
    });
    // A background fetch in flight suspends scheduling.
    expect(result.current.fetching).toBe(true);
    expect(result.current.nextRefreshAt).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1_000)); // the fetch takes 1s
    act(() => result.current.settleFetch());
    expect(result.current.fetching).toBe(false);
    // Anchored at settle time, not at the trigger.
    expect(result.current.nextRefreshAt).toBe(T0 + 1_000 + 30_000);

    // A foreground load also suspends the schedule without moving the anchor.
    rerender({ ...initialProps, loading: true });
    expect(result.current.fetching).toBe(true);
    expect(result.current.nextRefreshAt).toBeNull();
    rerender({ ...initialProps, loading: false });
    expect(result.current.nextRefreshAt).toBe(T0 + 31_000);

    // The scheduled tick triggers a quiet background refresh through the same flag.
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current.refreshToken).toBe(2);
    expect(onTrigger).toHaveBeenLastCalledWith(true);
    let background!: boolean;
    act(() => {
      background = result.current.beginFetch();
    });
    expect(background).toBe(true);
  });

  it("markInteracting suspends auto-refresh for filterSettleMs, then the blocked tick fires once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { result, onTrigger } = renderDashboardRefresh({
      intervalMs: 3_000,
      filterSettleMs: 5_000,
    });
    act(() => result.current.settleFetch()); // anchor at T0
    expect(result.current.nextRefreshAt).toBe(T0 + 3_000);

    act(() => result.current.markInteracting());
    expect(result.current.nextRefreshAt).toBeNull();

    // The tick due at T0+3s stays blocked for the whole settle window.
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(onTrigger).not.toHaveBeenCalled();
    expect(result.current.refreshToken).toBe(0);

    // Window ends at T0+5s; the past-due tick fires exactly once (delay clamped to 0).
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(true);
    expect(result.current.refreshToken).toBe(1);

    // Exactly once per anchor: nothing re-arms until another settleFetch.
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // The resumed tick is a quiet background refresh.
    let background!: boolean;
    act(() => {
      background = result.current.beginFetch();
    });
    expect(background).toBe(true);
  });
});

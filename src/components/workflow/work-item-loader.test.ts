/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedWorkItem } from "@/components/workflow/work-item-loader";
import { useWorkItemLookup } from "@/components/workflow/work-item-loader";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import { projectScope } from "@/test/factories";

// The hook resolves postJson through the shared workflow barrel, not
// @/components/workflow/post-json directly — the mock must target the barrel.
const { postJsonMock } = vi.hoisted(() => ({
  postJsonMock: vi.fn<(url: string, body: unknown) => Promise<{ workItem: LoadedWorkItem }>>(),
}));
vi.mock("@/components/workflow/test-intelligence-shared", () => ({
  postJson: postJsonMock,
  isRequirementLikeType: (workItemType: string) => workItemType === "User Story",
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function workItem(id: string): LoadedWorkItem {
  return { id, title: `Story ${id}`, workItemType: "User Story" };
}

const idle = { loading: false, error: null, data: null };

type LookupProps = Parameters<typeof useWorkItemLookup>[0];

function renderLookup(initialProps: LookupProps) {
  return renderHook((props: LookupProps) => useWorkItemLookup(props), { initialProps });
}

describe("useWorkItemLookup", () => {
  // Hoisted module mock: the global restore hook only covers spies, so drop
  // call history and per-test implementations here.
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it("flags a non-numeric ID immediately and never fetches", async () => {
    vi.useFakeTimers();
    const { result } = renderLookup({ scope: projectScope(), workItemId: "12a" });
    // No debounce for validation: the error is set synchronously by the effect.
    expect(result.current).toEqual({
      loading: false,
      error: "Enter a valid numeric work item ID.",
      data: null,
    });

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("uses the caller's invalidIdMessage for non-numeric input", () => {
    vi.useFakeTimers();
    const { result } = renderLookup({
      scope: projectScope(),
      workItemId: "abc",
      invalidIdMessage: "Numbers only.",
    });
    expect(result.current.error).toBe("Numbers only.");
  });

  it("stays idle without fetching when input is blank, scope is null, or enabled is false", async () => {
    vi.useFakeTimers();
    const scope: ActiveProjectScope = projectScope();
    const blank = renderLookup({ scope, workItemId: "   " });
    const noScope = renderLookup({ scope: null, workItemId: "123" });
    const disabled = renderLookup({ scope, workItemId: "123", enabled: false });

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(blank.result.current).toEqual(idle);
    expect(noScope.result.current).toEqual(idle);
    expect(disabled.result.current).toEqual(idle);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("resets loaded data back to idle when the input is cleared", async () => {
    vi.useFakeTimers();
    const scope = projectScope();
    postJsonMock.mockResolvedValue({ workItem: workItem("123") });
    const { result, rerender } = renderLookup({ scope, workItemId: "123" });
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(result.current.data).toEqual(workItem("123"));

    rerender({ scope, workItemId: "" });
    expect(result.current).toEqual(idle);

    // Same reset when the caller disables the lookup instead of clearing the field.
    postJsonMock.mockClear();
    rerender({ scope, workItemId: "123" });
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(result.current.data).toEqual(workItem("123"));
    rerender({ scope, workItemId: "123", enabled: false });
    expect(result.current).toEqual(idle);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(postJsonMock).toHaveBeenCalledTimes(1);
  });

  it("fires exactly one request only after the 700ms debounce, trimming the ID", async () => {
    vi.useFakeTimers();
    const scope = projectScope();
    const gate = deferred<{ workItem: LoadedWorkItem }>();
    postJsonMock.mockReturnValue(gate.promise);
    const { result } = renderLookup({ scope, workItemId: "  123  " });
    expect(result.current).toEqual(idle);

    // One tick before the debounce boundary nothing has happened yet.
    await act(async () => vi.advanceTimersByTimeAsync(699));
    expect(postJsonMock).not.toHaveBeenCalled();
    expect(result.current).toEqual(idle);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(postJsonMock).toHaveBeenCalledWith("/api/azure-devops/work-item-details", {
      scope,
      workItemId: "123",
    });
    expect(result.current).toEqual({ loading: true, error: null, data: null });

    await act(async () => {
      gate.resolve({ workItem: workItem("123") });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ loading: false, error: null, data: workItem("123") });
    expect(postJsonMock).toHaveBeenCalledTimes(1);
  });

  it("restarts the debounce window when the ID changes mid-wait, still firing once", async () => {
    vi.useFakeTimers();
    const scope = projectScope();
    postJsonMock.mockResolvedValue({ workItem: workItem("1234") });
    const { result, rerender } = renderLookup({ scope, workItemId: "123" });

    await act(async () => vi.advanceTimersByTimeAsync(400));
    rerender({ scope, workItemId: "1234" });
    // 800ms after the first keystroke but only 400ms after the last one: no request.
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(postJsonMock).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(postJsonMock).toHaveBeenCalledWith("/api/azure-devops/work-item-details", {
      scope,
      workItemId: "1234",
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.data).toEqual(workItem("1234"));
  });

  it("ignores a stale response that settles after a newer request already resolved", async () => {
    vi.useFakeTimers();
    const scope = projectScope();
    const gates = new Map<string, ReturnType<typeof deferred<{ workItem: LoadedWorkItem }>>>();
    postJsonMock.mockImplementation((_url, body) => {
      const gate = deferred<{ workItem: LoadedWorkItem }>();
      gates.set((body as { workItemId: string }).workItemId, gate);
      return gate.promise;
    });

    const { result, rerender } = renderLookup({ scope, workItemId: "111" });
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(result.current.loading).toBe(true);

    // Second lookup starts while the first response is still in flight.
    rerender({ scope, workItemId: "222" });
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(postJsonMock).toHaveBeenCalledTimes(2);

    // Newer response lands first...
    await act(async () => {
      gates.get("222")!.resolve({ workItem: workItem("222") });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ loading: false, error: null, data: workItem("222") });

    // ...then the stale one settles and must not clobber the newer state.
    await act(async () => {
      gates.get("111")!.resolve({ workItem: workItem("111") });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ loading: false, error: null, data: workItem("222") });
  });

  it("surfaces an Error rejection's message as the error state", async () => {
    vi.useFakeTimers();
    postJsonMock.mockRejectedValue(new Error("Work item 999 was not found."));
    const { result } = renderLookup({ scope: projectScope(), workItemId: "999" });
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(result.current).toEqual({
      loading: false,
      error: "Work item 999 was not found.",
      data: null,
    });
  });

  it("falls back to the configured errorMessage for a non-Error rejection", async () => {
    vi.useFakeTimers();
    postJsonMock.mockRejectedValue("boom");
    const { result } = renderLookup({
      scope: projectScope(),
      workItemId: "42",
      errorMessage: "Could not load the work item.",
    });
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(result.current).toEqual({
      loading: false,
      error: "Could not load the work item.",
      data: null,
    });
  });
});

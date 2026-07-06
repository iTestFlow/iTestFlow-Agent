/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActiveProjectScope } from "@/shared/lib/active-project";
import {
  projectScopeKey,
  retainAvailableSelections,
  selectAvailableDefaults,
  useProjectWorkItemMetadata,
  type ProjectWorkItemMetadata,
} from "@/shared/lib/use-project-work-item-metadata";
import { projectScope } from "@/test/factories";

// Vitest globals are off, so RTL never registers its own cleanup.
afterEach(cleanup);

/* ---------------------------------------------------------------------------
 * useProjectWorkItemMetadata harness
 *
 * The hook memoizes per scope in a module-level Map that outlives each test,
 * so every test below uses its own azureProjectId to keep cache entries
 * isolated. The fetch stub is unstubbed by the global afterEach in
 * src/test/setup.ts.
 * ------------------------------------------------------------------------ */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type MetadataRequest = {
  body: unknown;
  signal: AbortSignal | undefined;
  resolve: (response: Response) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Replaces global fetch with one gate per request so tests decide when and how
 * each metadata call settles. Honors the hook's AbortSignal the way real fetch
 * does: aborting rejects the still-pending promise with an AbortError.
 */
function stubMetadataFetch() {
  const requests: MetadataRequest[] = [];
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    void _input;
    const gate = deferred<Response>();
    init?.signal?.addEventListener(
      "abort",
      () => gate.reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal ?? undefined,
      resolve: gate.resolve,
      reject: gate.reject,
    });
    return gate.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

function renderMetadataHook(initialScope: ActiveProjectScope | null) {
  return renderHook((scope: ActiveProjectScope | null) => useProjectWorkItemMetadata(scope), {
    initialProps: initialScope,
  });
}

/** Settles gated requests inside act; one macrotask lets the hook's whole then/catch/finally chain run. */
async function settle(action: () => void) {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const storyMetadata: ProjectWorkItemMetadata = {
  workItemTypes: ["User Story", "Bug"],
  states: ["New", "Active", "Closed"],
};

const taskMetadata: ProjectWorkItemMetadata = {
  workItemTypes: ["Task"],
  states: ["To Do", "Done"],
};

describe("useProjectWorkItemMetadata", () => {
  it("POSTs the scope and exposes the metadata once the request resolves", async () => {
    const { fetchMock, requests } = stubMetadataFetch();
    const scope = projectScope({ azureProjectId: "metadata-success" });
    const { result } = renderMetadataHook(scope);

    // Loading is true from the very first render for an uncached scope.
    expect(result.current.loading).toBe(true);
    expect(result.current.metadata).toBeNull();
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/azure-devops/work-item-metadata",
      expect.objectContaining({ method: "POST" }),
    );
    expect(requests[0].body).toEqual({ scope });

    await settle(() => requests[0].resolve(jsonResponse(storyMetadata)));
    expect(result.current.loading).toBe(false);
    expect(result.current.metadata).toEqual(storyMetadata);
    expect(result.current.error).toBeNull();
  });

  it("does nothing without a scope and resets when the scope is deactivated", async () => {
    const { fetchMock, requests } = stubMetadataFetch();
    const { result, rerender } = renderMetadataHook(null);
    expect(result.current.metadata).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(projectScope({ azureProjectId: "metadata-deactivate" }));
    await settle(() => requests[0].resolve(jsonResponse(taskMetadata)));
    expect(result.current.metadata).toEqual(taskMetadata);

    // Clearing the scope drops the metadata instead of showing another project's rows.
    rerender(null);
    expect(result.current.metadata).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves an already-fetched scope from the cache and only fetches new scopes", async () => {
    const { fetchMock, requests } = stubMetadataFetch();
    const scopeA = projectScope({ azureProjectId: "metadata-cache-a" });
    const scopeB = projectScope({ azureProjectId: "metadata-cache-b" });
    const { result, rerender, unmount } = renderMetadataHook(scopeA);
    await settle(() => requests[0].resolve(jsonResponse(storyMetadata)));
    expect(result.current.metadata).toEqual(storyMetadata);

    // A scope the cache has never seen fetches; the previous project's metadata
    // is dropped immediately rather than shown against the wrong project.
    rerender(scopeB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.metadata).toBeNull();
    expect(result.current.loading).toBe(true);
    await settle(() => requests[1].resolve(jsonResponse(taskMetadata)));
    expect(result.current.metadata).toEqual(taskMetadata);

    // Returning to the first scope is a synchronous cache hit — no third request.
    rerender(scopeA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.metadata).toEqual(storyMetadata);
    expect(result.current.loading).toBe(false);

    // The cache outlives the hook instance: a remount never re-fetches or flashes loading.
    unmount();
    const remounted = renderMetadataHook(scopeA);
    expect(remounted.result.current.loading).toBe(false);
    expect(remounted.result.current.metadata).toEqual(storyMetadata);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server's error message and retry() clears it with a fresh request", async () => {
    const { fetchMock, requests } = stubMetadataFetch();
    const scope = projectScope({ azureProjectId: "metadata-retry" });
    const { result } = renderMetadataHook(scope);

    await settle(() =>
      requests[0].resolve(jsonResponse({ error: "Azure DevOps rejected the token." }, 401)),
    );
    expect(result.current.error).toBe("Azure DevOps rejected the token.");
    expect(result.current.metadata).toBeNull();
    expect(result.current.loading).toBe(false);

    // retry() evicts the scope's cache entry and re-runs the request.
    act(() => result.current.retry());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    await settle(() => requests[1].resolve(jsonResponse(storyMetadata)));
    expect(result.current.metadata).toEqual(storyMetadata);
    expect(result.current.error).toBeNull();
  });

  it("falls back to the generic message when the failure carries no server detail", async () => {
    const { requests } = stubMetadataFetch();

    // Non-ok response whose body has no error field.
    const withoutDetail = renderMetadataHook(projectScope({ azureProjectId: "metadata-error-shape" }));
    await settle(() => requests[0].resolve(jsonResponse({}, 500)));
    expect(withoutDetail.result.current.error).toBe(
      "Azure DevOps work item metadata fetch failed.",
    );
    expect(withoutDetail.result.current.loading).toBe(false);

    // Non-Error rejections (fetch can technically reject with anything) get the same fallback.
    const nonError = renderMetadataHook(projectScope({ azureProjectId: "metadata-error-reject" }));
    await settle(() => requests[1].reject("boom"));
    expect(nonError.result.current.error).toBe("Azure DevOps work item metadata fetch failed.");
    expect(nonError.result.current.loading).toBe(false);
  });

  it("abandons an in-flight request when the scope switches, without surfacing an error", async () => {
    const { fetchMock, requests } = stubMetadataFetch();
    const scopeA = projectScope({ azureProjectId: "metadata-abort-a" });
    const scopeB = projectScope({ azureProjectId: "metadata-abort-b" });
    const { result, rerender, unmount } = renderMetadataHook(scopeA);
    expect(result.current.loading).toBe(true);

    // Switching scope aborts the previous request via its AbortSignal...
    rerender(scopeB);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ...and once its rejection chain settles, the AbortError neither surfaces
    // an error nor ends the NEW request's loading state.
    await settle(() => {});
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    await settle(() => requests[1].resolve(jsonResponse(taskMetadata)));
    expect(result.current.metadata).toEqual(taskMetadata);
    expect(result.current.error).toBeNull();

    // Unmount aborts too, so a late response cannot update unmounted state.
    unmount();
    expect(requests[1].signal?.aborted).toBe(true);
  });
});

describe("projectScopeKey", () => {
  it("returns null when no scope is active", () => {
    expect(projectScopeKey(null)).toBeNull();
  });

  it("normalizes the organization URL by trimming and lowercasing", () => {
    const scope = projectScope({
      azureOrganizationUrl: "  HTTPS://Dev.Azure.com/Demo  ",
      azureProjectId: "azure-project-1",
    });

    expect(projectScopeKey(scope)).toBe("https://dev.azure.com/demo::azure-project-1");
  });

  it("produces one cache key per org/project pair regardless of URL casing", () => {
    const scope = projectScope({ azureOrganizationUrl: "https://dev.azure.com/demo" });
    const recasedScope = projectScope({ azureOrganizationUrl: "https://DEV.azure.com/demo " });

    expect(projectScopeKey(recasedScope)).toBe(projectScopeKey(scope));
  });

  it("keys by project id so sibling projects in the same org do not collide", () => {
    const scope = projectScope({ azureProjectId: "azure-project-1" });
    const siblingScope = projectScope({ azureProjectId: "azure-project-2" });

    expect(projectScopeKey(siblingScope)).not.toBe(projectScopeKey(scope));
  });
});

describe("selectAvailableDefaults", () => {
  it("matches case- and whitespace-insensitively and returns the option's canonical casing", () => {
    const options = ["Bug", "User Story", "Task"];

    expect(selectAvailableDefaults(["  bug ", "USER STORY"], options)).toEqual([
      "Bug",
      "User Story",
    ]);
  });

  it("drops defaults with no matching option in the new project", () => {
    expect(selectAvailableDefaults(["Bug", "Epic"], ["Bug", "Task"])).toEqual(["Bug"]);
  });

  it("returns nothing when the project exposes no options", () => {
    expect(selectAvailableDefaults(["Bug", "Task"], [])).toEqual([]);
  });

  it("returns nothing when there are no defaults", () => {
    expect(selectAvailableDefaults([], ["Bug", "Task"])).toEqual([]);
  });
});

describe("retainAvailableSelections", () => {
  it("keeps selections that still exist, re-emitting the option's canonical casing", () => {
    const options = ["Active", "Closed", "New"];

    expect(retainAvailableSelections(["active", " CLOSED "], options)).toEqual([
      "Active",
      "Closed",
    ]);
  });

  it("drops selections unavailable after a project switch, preserving selection order", () => {
    const options = ["New", "Resolved"];

    expect(retainAvailableSelections(["Resolved", "Removed", "New"], options)).toEqual([
      "Resolved",
      "New",
    ]);
  });

  it("returns nothing when the project exposes no options", () => {
    expect(retainAvailableSelections(["Active"], [])).toEqual([]);
  });

  it("returns nothing when nothing was selected", () => {
    expect(retainAvailableSelections([], ["Active"])).toEqual([]);
  });
});

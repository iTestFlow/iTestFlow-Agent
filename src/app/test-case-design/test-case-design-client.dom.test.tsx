// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => {
  const generation = {
    cancel: vi.fn(),
    elapsedSeconds: 0,
    error: null,
    errorMessage: null,
    isRunning: false,
    retry: vi.fn(),
    start: vi.fn(),
    status: "idle" as const,
    tokenUsage: null,
    warnings: [],
  };
  return {
    generation,
    loadingGame: {
      completeSession: vi.fn(),
      endSession: vi.fn(),
      panel: null,
      shouldKeepPanelMounted: false,
      startSession: vi.fn(),
    },
  };
});

vi.mock("@/components/navigation/unsaved-changes-provider", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));
vi.mock("@/components/workflow/use-ai-generation", () => ({
  useAiGeneration: () => hookState.generation,
}));
vi.mock("@/components/workflow/llm-loading-games/use-llm-loading-game-session", () => ({
  useLlmLoadingGameSession: () => hookState.loadingGame,
}));
vi.mock("@/components/workflow/generation-mode-toggle", () => ({
  GenerationModeToggle: () => <div>Generation mode</div>,
}));
vi.mock("@/components/workflow/work-item-loader", () => ({
  WORK_ITEM_ID_PLACEHOLDER: "Enter work item ID",
  WORK_ITEM_ID_TITLE: "Work Item ID",
  WorkItemPreview: () => null,
  useWorkItemLookup: () => ({ data: null }),
}));
vi.mock("@/shared/lib/use-external-llm-availability", () => ({
  useExternalLlmAvailability: () => ({ enabled: false }),
}));

import { TestCaseDesignClient } from "./test-case-design-client";

function sessionResponse(providerId: unknown, status = 200) {
  return new Response(JSON.stringify({ workspace: { providerId } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectNeutralProviderUi() {
  expect(screen.getByText("Generate Test Cases from a Work Item")).toBeInTheDocument();
  expect(screen.getByText("Please select a project before running this action.")).toBeInTheDocument();
  expect(screen.queryByText(/Azure DevOps/)).not.toBeInTheDocument();
  expect(screen.queryByText("Create requirement-based suite for this user story")).not.toBeInTheDocument();
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TestCaseDesignClient provider resolution", () => {
  it("renders neutral copy while the session is pending, then enables Azure copy only after Azure resolves", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<TestCaseDesignClient />);

    expectNeutralProviderUi();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", { cache: "no-store" });

    await act(async () => response.resolve(sessionResponse("azure-devops")));

    await waitFor(() => {
      expect(screen.getByText("Generate Test Cases from Azure DevOps Requirement")).toBeInTheDocument();
      expect(screen.getByText("Please select an Azure DevOps project before running this action.")).toBeInTheDocument();
    });
  });

  it("renders Jira issue copy for a recognized Jira workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sessionResponse("jira-cloud")));

    render(<TestCaseDesignClient />);

    await waitFor(() => {
      expect(screen.getByText("Generate Test Cases from a Jira Issue")).toBeInTheDocument();
      expect(screen.getByText("Please select a Jira project before running this action.")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Azure DevOps/)).not.toBeInTheDocument();
  });

  it.each([
    ["a non-OK session", () => Promise.resolve(sessionResponse("azure-devops", 503))],
    ["a rejected session", () => Promise.reject(new Error("session unavailable"))],
    ["an unknown provider", () => Promise.resolve(sessionResponse("unknown-provider"))],
  ])("keeps neutral copy for %s", async (_label, responseFactory) => {
    const fetchMock = vi.fn(responseFactory);
    vi.stubGlobal("fetch", fetchMock);

    render(<TestCaseDesignClient />);

    await act(async () => {
      await fetchMock.mock.results[0]?.value.catch(() => undefined);
    });
    expectNeutralProviderUi();
  });
});

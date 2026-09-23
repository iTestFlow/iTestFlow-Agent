// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => ({
  generation: {
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
  },
  loadingGame: {
    completeSession: vi.fn(),
    endSession: vi.fn(),
    panel: null,
    shouldKeepPanelMounted: false,
    startSession: vi.fn(),
  },
  scope: {
    workspaceId: "workspace-1",
    projectId: "project-1",
    azureProjectId: "azure-project-1",
    azureProjectName: "Demo Project",
    azureOrganizationUrl: "https://dev.azure.com/demo",
  },
}));

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
  GenerationModeToggle: ({ onChange }: { onChange: (mode: "auto" | "manual") => void }) => (
    <button type="button" onClick={() => onChange("manual")}>Manual mode</button>
  ),
}));
vi.mock("@/components/workflow/manual-llm-panel", () => ({
  ManualLLMPanel: ({ response, onResponseChange, onSubmit }: {
    response: string;
    onResponseChange: (value: string) => void;
    onSubmit: () => void;
  }) => (
    <div>
      <textarea aria-label="External LLM Response" value={response} onChange={(event) => onResponseChange(event.target.value)} />
      <button type="button" onClick={onSubmit}>Validate and Continue</button>
    </div>
  ),
}));
vi.mock("@/components/workflow/work-item-loader", () => ({
  WORK_ITEM_ID_PLACEHOLDER: "Enter work item ID",
  WORK_ITEM_ID_TITLE: "Work Item ID",
  WorkItemPreview: () => null,
  useWorkItemLookup: () => ({ data: null }),
}));
vi.mock("@/components/workflow/story-attachments-panel", () => ({
  StoryAttachmentsPanel: () => null,
}));
vi.mock("@/shared/lib/use-external-llm-availability", () => ({
  useExternalLlmAvailability: () => ({ enabled: true }),
}));
vi.mock("@/shared/lib/use-active-project", () => ({
  useActiveProject: () => hookState.scope,
}));

import { TestCaseDesignClient } from "./test-case-design-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const reviewData = {
  reviewedSourceIds: ["WI:200"],
  excludedSourceIds: [],
  contextCitations: [{
    sourceType: "project_context",
    sourceId: "WI:200",
    title: "Related story",
    reason: "Linked to this story.",
    workItemId: "200",
    workItemType: "User Story",
  }],
};

function sessionResponse() {
  return jsonResponse({ workspace: { id: hookState.scope.workspaceId, providerId: "azure-devops" } });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  hookState.scope = {
    workspaceId: "workspace-1", projectId: "project-1", azureProjectId: "azure-project-1",
    azureProjectName: "Demo Project", azureOrganizationUrl: "https://dev.azure.com/demo",
  };
  hookState.generation.start.mockImplementation(async (work: (signal: AbortSignal) => Promise<unknown>) =>
    work(new AbortController().signal));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Test Case Design context review", () => {
  it("ignores a preview returned after the story changes and reports a fresh preview failure", async () => {
    const firstPreview = deferred<Response>();
    let previewCount = 0;
    const fetchMock = vi.fn((...args: [string, RequestInit?]) => {
      const [url] = args;
      if (url.startsWith("/api/auth/session")) return Promise.resolve(sessionResponse());
      if (url === "/api/workflow-context/preview") {
        previewCount += 1;
        return previewCount === 1
          ? firstPreview.promise
          : Promise.resolve(jsonResponse({ error: "Preview unavailable." }, 503));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TestCaseDesignClient />);
    await screen.findByText("Generate Test Cases from Azure DevOps Requirement");

    const storyInput = screen.getByRole("textbox", { name: "Work Item ID" });
    await user.type(storyInput, "101");
    await user.click(screen.getByRole("button", { name: "Review context" }));
    expect(screen.getByRole("button", { name: "Reviewing..." })).toBeDisabled();

    await user.clear(storyInput);
    await user.type(storyInput, "102");
    await act(async () => firstPreview.resolve(jsonResponse(reviewData)));
    expect(screen.queryByRole("dialog", { name: "All Context References" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Review context" }));
    expect(await screen.findByText("Preview unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "All Context References" })).not.toBeInTheDocument();
  });

  it("keeps exclusions for the current story and resets them when the story changes", async () => {
    const fetchMock = vi.fn((...args: [string, RequestInit?]) => {
      const [url] = args;
      if (url.startsWith("/api/auth/session")) return Promise.resolve(sessionResponse());
      if (url === "/api/workflow-context/preview") return Promise.resolve(jsonResponse(reviewData));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TestCaseDesignClient />);
    await screen.findByText("Generate Test Cases from Azure DevOps Requirement");

    const storyInput = screen.getByRole("textbox", { name: "Work Item ID" });
    await user.type(storyInput, "101");
    await user.click(screen.getByRole("button", { name: "Review context" }));
    await user.click(await screen.findByRole("button", { name: "Remove Related story from context" }));
    expect(screen.getByRole("dialog", { name: "All Context References" })).toHaveTextContent("0 included, 1 excluded");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Review context" }));
    expect(screen.getByRole("dialog", { name: "All Context References" })).toHaveTextContent("0 included, 1 excluded");
    await user.keyboard("{Escape}");

    await user.clear(storyInput);
    await user.type(storyInput, "102");
    await user.click(screen.getByRole("button", { name: "Review context" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "All Context References" })).toHaveTextContent("1 included, 0 excluded"));
    const previewRequests = fetchMock.mock.calls
      .filter(([url]) => url === "/api/workflow-context/preview")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { excludedSourceIds: string[] });
    expect(previewRequests).toHaveLength(2);
    expect(previewRequests[1]?.excludedSourceIds).toEqual([]);
  });

  it("ignores a manual submit response after a project switch", async () => {
    const submit = deferred<Response>();
    const fetchMock = vi.fn((...args: [string, RequestInit?]) => {
      const [url] = args;
      if (url.startsWith("/api/auth/session")) return Promise.resolve(sessionResponse());
      if (url === "/api/test-cases/manual/draft") return Promise.resolve(jsonResponse({
        prompt: "Prepared prompt", promptVersion: "1", contextCitations: [],
        selectedContextIds: [], resolvedContextUsed: [], retrievalTopK: 6,
      }));
      if (url === "/api/test-cases/manual/submit") return submit.promise;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(<TestCaseDesignClient />);
    await screen.findByText("Generate Test Cases from Azure DevOps Requirement");
    await user.type(screen.getByRole("textbox", { name: "Work Item ID" }), "101");
    await user.click(screen.getByRole("button", { name: "Manual mode" }));
    await user.click(screen.getByRole("button", { name: "Prepare Prompt" }));
    await user.type(await screen.findByRole("textbox", { name: "External LLM Response" }), "response");
    await user.click(screen.getByRole("button", { name: "Validate and Continue" }));

    hookState.scope = { ...hookState.scope, projectId: "project-2", azureProjectId: "azure-project-2" };
    view.rerender(<TestCaseDesignClient />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Work Item ID" })).toHaveValue(""));
    await act(async () => submit.resolve(jsonResponse({ testCases: [{ id: "stale-case", title: "Old project result" }] })));

    expect(screen.queryByText("Old project result")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Work Item ID" }), "202");
    expect(screen.getByRole("button", { name: "Prepare Prompt" })).toBeEnabled();
  });
});

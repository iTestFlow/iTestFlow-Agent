// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TestCaseGenerationRunResult } from "@/components/workflow/test-intelligence-types";
import { writeActiveProject } from "@/shared/lib/active-project";
import { ApiError } from "@/components/workflow/api-error";
import { AppErrorCode } from "@/modules/shared/errors/app-error";

const mocks = vi.hoisted(() => ({
  postJson: vi.fn(),
  completed: undefined as ((data: TestCaseGenerationRunResult) => void) | undefined,
  generation: {
    cancel: vi.fn(), start: vi.fn(), retry: vi.fn(), elapsedSeconds: 0,
    error: null, errorMessage: null, isRunning: false, status: "idle", tokenUsage: null, warnings: [],
  },
  loadingGame: {
    completeSession: vi.fn(), endSession: vi.fn(), startSession: vi.fn(),
    panel: null, shouldKeepPanelMounted: false,
  },
  storyAttachmentProps: null as null | { onSelectedAttachmentIdsChange: (ids: string[]) => void },
  externalLlmEnabled: false,
}));
vi.mock("@/components/workflow/post-json", () => ({ postJson: mocks.postJson }));
vi.mock("@/components/navigation/unsaved-changes-provider", () => ({ useUnsavedChangesGuard: vi.fn() }));
vi.mock("@/components/workflow/use-ai-generation", () => ({ useAiGeneration: () => mocks.generation }));
vi.mock("@/components/workflow/llm-loading-games/use-llm-loading-game-session", () => ({
  useLlmLoadingGameSession: (completed: (data: TestCaseGenerationRunResult) => void) => {
    mocks.completed = completed;
    return mocks.loadingGame;
  },
}));
vi.mock("@/components/workflow/generation-mode-toggle", () => ({
  GenerationModeToggle: ({ onChange }: { onChange: (mode: "manual") => void }) => (
    <button type="button" onClick={() => onChange("manual")}>Use External LLM</button>
  ),
}));
vi.mock("@/components/workflow/work-item-loader", () => ({
  WORK_ITEM_ID_PLACEHOLDER: "Enter work item ID", WORK_ITEM_ID_TITLE: "Work Item ID",
  WorkItemPreview: () => null, useWorkItemLookup: () => ({ data: null }),
}));
vi.mock("@/components/workflow/story-attachments-panel", () => ({
  StoryAttachmentsPanel: (props: { onSelectedAttachmentIdsChange: (ids: string[]) => void }) => {
    mocks.storyAttachmentProps = props;
    return <button type="button" onClick={() => props.onSelectedAttachmentIdsChange(["attachment-1"])}>Use story attachment</button>;
  },
}));
vi.mock("@/shared/lib/use-external-llm-availability", () => ({
  useExternalLlmAvailability: () => ({ enabled: mocks.externalLlmEnabled }),
}));

import { TestCaseDesignClient } from "./test-case-design-client";

const scope = {
  workspaceId: "workspace-1", projectId: "project-1", azureProjectId: "project-1",
  azureProjectName: "Demo", azureOrganizationUrl: "https://dev.azure.com/demo",
};
const generated: TestCaseGenerationRunResult = {
  testCases: ["TC-1", "TC-2"].map((id) => ({
    id, title: `Checkout ${id}`, description: "Checkout succeeds", priority: 1,
    type: "functional", category: "Checkout", preconditions: "Customer has a cart",
    steps: [{ stepNumber: 1, action: "Submit payment", expectedResult: "Order created" }],
  })),
  summary: { totalCases: 2, byType: { functional: 2 }, byPriority: { "1": 2 }, coverageEstimate: 100 },
  contextUsed: [], contextCitations: [],
};

function session(providerId: string, workspaceId = scope.workspaceId, status = 200) {
  return new Response(JSON.stringify({ authenticated: true, workspace: { id: workspaceId, providerId } }), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.externalLlmEnabled = false;
  writeActiveProject(scope);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  mocks.generation.start.mockImplementation((request: (signal: AbortSignal) => Promise<unknown>) => request(new AbortController().signal));
  mocks.loadingGame.completeSession.mockImplementation((data: TestCaseGenerationRunResult) => mocks.completed?.(data));
  mocks.postJson.mockImplementation(async (url: string) => {
    if (url === "/api/test-cases/generate") return structuredClone(generated);
    if (url === "/api/publish/test-cases") return { suiteMode: "none", results: [{ localId: "TC-1", azureTestCaseId: "1001", success: true }] };
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function generateCases() {
  fireEvent.change(screen.getByLabelText("Work Item ID"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  await screen.findByRole("heading", { name: "Checkout TC-1" });
}

it.each(["azure-devops", "jira-cloud"])("preserves edits and selections when retry restores %s publishing", async (provider) => {
  const recovery = deferred<Response>();
  const fetchMock = vi.fn().mockResolvedValueOnce(session(provider, scope.workspaceId, 503)).mockReturnValueOnce(recovery.promise);
  vi.stubGlobal("fetch", fetchMock);
  render(<TestCaseDesignClient />);
  await generateCases();
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  fireEvent.change(screen.getByDisplayValue("Checkout TC-1"), { target: { value: "Edited checkout" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select TC-2" }));
  expect(screen.getByRole("button", { name: "Publish 1" })).toBeDisabled();

  fireEvent.click(await screen.findByRole("button", { name: "Retry workspace lookup" }));
  expect(screen.getByRole("heading", { name: "Edited checkout" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Select TC-2" })).toHaveAttribute("aria-checked", "false");
  expect(screen.getByRole("button", { name: "Publish 1" })).toBeDisabled();
  expect(mocks.postJson.mock.calls.filter(([url]) => url === "/api/test-cases/generate")).toHaveLength(1);
  await act(async () => recovery.resolve(session(provider)));

  await waitFor(() => expect(screen.getByRole("button", { name: "Publish 1" })).toBeEnabled());
  expect(screen.getByRole("heading", { name: "Edited checkout" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Select TC-2" })).toHaveAttribute("aria-checked", "false");
  expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/session?workspaceId=workspace-1", expect.objectContaining({ cache: "no-store" }));
  const suiteControl = screen.queryByText("Create requirement-based suite for this user story");
  if (provider === "azure-devops") expect(suiteControl).toBeInTheDocument();
  else expect(suiteControl).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Publish 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Publish cases" }));
  await waitFor(() => expect(mocks.postJson).toHaveBeenCalledWith("/api/publish/test-cases", expect.objectContaining({
    targetWorkItemId: "123", suiteMode: "none", testCases: [expect.objectContaining({ id: "TC-1", title: "Edited checkout" })],
  })));
});

it("recovers from a network rejection but keeps unknown providers blocked", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(session("unknown-provider")).mockResolvedValueOnce(session("azure-devops"));
  vi.stubGlobal("fetch", fetchMock);
  render(<TestCaseDesignClient />);
  await generateCases();
  fireEvent.click(await screen.findByRole("button", { name: "Retry workspace lookup" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Publish 2" })).toBeDisabled();
  fireEvent.click(await screen.findByRole("button", { name: "Retry workspace lookup" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish 2" })).toBeEnabled());
});

it("ignores an earlier workspace response after a project switch", async () => {
  const old = deferred<Response>();
  const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(session("jira-cloud", "workspace-2"));
  vi.stubGlobal("fetch", fetchMock);
  render(<TestCaseDesignClient />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => writeActiveProject({ ...scope, workspaceId: "workspace-2", projectId: "project-2", azureProjectId: "project-2" }));
  await screen.findByText("Generate Test Cases from a Jira Issue");
  await act(async () => old.resolve(session("azure-devops")));
  expect(screen.getByText("Generate Test Cases from a Jira Issue")).toBeInTheDocument();
  expect(screen.queryByText("Generate Test Cases from Azure DevOps Requirement")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/session?workspaceId=workspace-2", expect.objectContaining({ cache: "no-store" }));
});

it("rejects a recognized provider returned for the wrong workspace", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(session("azure-devops", "wrong-workspace")));
  render(<TestCaseDesignClient />);
  await generateCases();
  expect(await screen.findByRole("button", { name: "Retry workspace lookup" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Publish 2" })).toBeDisabled();
  expect(screen.queryByText("Create requirement-based suite for this user story")).not.toBeInTheDocument();
});

it("sends selected story attachments with the generation request", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(session("azure-devops")));
  render(<TestCaseDesignClient />);
  fireEvent.change(screen.getByLabelText("Work Item ID"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Use story attachment" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));

  await waitFor(() => expect(mocks.postJson).toHaveBeenCalledWith(
    "/api/test-cases/generate",
    expect.objectContaining({ targetWorkItemId: "123", attachmentIds: ["attachment-1"] }),
    expect.any(AbortSignal),
  ));
});

it("recalculates full and selected AC mappings and drops the validation badge after edits", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(session("azure-devops")));
  const output = structuredClone(generated);
  output.testCases[0].relatedAcceptanceCriteria = ["AC-001"];
  output.testCases[1].relatedAcceptanceCriteria = ["AC-002"];
  output.acceptanceCriteriaContract = { version: "1", sourceHash: "hash", criteria: [
    { id: "AC-001", text: "Card payment succeeds" },
    { id: "AC-002", text: "Order receipt appears" },
  ] };
  mocks.postJson.mockImplementation(async (url: string) => {
    if (url === "/api/test-cases/generate") return output;
    throw new Error(`Unexpected request: ${url}`);
  });
  render(<TestCaseDesignClient />);
  await generateCases();
  const mapping = screen.getByRole("region", { name: "Acceptance criteria mapping" });
  expect(mapping).toHaveTextContent("2 of 2 AC IDs mapped.");
  expect(mapping).toHaveTextContent("Server validated");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select TC-2" }));
  expect(mapping).toHaveTextContent("Selected cases: 1 of 2 AC IDs mapped.");
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  fireEvent.change(screen.getByDisplayValue("Checkout TC-1"), { target: { value: "Edited checkout" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(mapping).toHaveTextContent("Edited since validation");
  fireEvent.click(screen.getByText("Show acceptance criteria and linked cases"));
  expect(screen.getByRole("link", { name: "TC-1" })).toHaveAttribute("href", "#test-case-TC-1");
});

it("explains when copied manual prompts omit selected visual evidence", async () => {
  mocks.externalLlmEnabled = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(session("azure-devops")));
  mocks.postJson.mockImplementation(async (url: string) => {
    if (url === "/api/test-cases/manual/draft") {
      return {
        prompt: "Create test cases from this requirement.",
        promptVersion: "2026-09-16",
        contextCitations: [],
        warnings: ["Visual attachment content is not embedded in copied prompts. To have an external LLM inspect it, upload the selected files to that external LLM as well."],
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  render(<TestCaseDesignClient />);
  fireEvent.click(screen.getByRole("button", { name: "Use External LLM" }));
  fireEvent.change(screen.getByLabelText("Work Item ID"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare Prompt" }));

  expect(await screen.findByText("Attachment context notice")).toBeInTheDocument();
  expect(screen.getByText(/Visual attachment content is not embedded in copied prompts/)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "External LLM prompt" })).toHaveValue("Create test cases from this requirement.");
});

it("keeps pasted manual output and offers a copyable correction prompt on missing ACs", async () => {
  mocks.externalLlmEnabled = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(session("azure-devops")));
  mocks.postJson.mockImplementation(async (url: string) => {
    if (url === "/api/test-cases/manual/draft") return { prompt: "Original prompt", promptVersion: "3.1.0", draftToken: "sealed-draft", contextCitations: [] };
    if (url === "/api/test-cases/manual/submit") throw new ApiError("Missing AC-002", {
      status: 422, code: AppErrorCode.AcceptanceCriteriaCoverage,
      payload: { details: { coverage: { missingCriteria: [{ id: "AC-002", text: "Show a receipt" }], unknownReferences: [] } } },
    });
    throw new Error(`Unexpected request: ${url}`);
  });
  render(<TestCaseDesignClient />);
  fireEvent.click(screen.getByRole("button", { name: "Use External LLM" }));
  fireEvent.change(screen.getByLabelText("Work Item ID"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare Prompt" }));
  await screen.findByRole("textbox", { name: "External LLM prompt" });
  fireEvent.change(screen.getByRole("textbox", { name: "External LLM Response" }), { target: { value: '{"testCases":[]}' } });
  fireEvent.click(screen.getByRole("button", { name: "Validate and Continue" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "External LLM prompt" }) as HTMLTextAreaElement).value).toContain("AC-002: Show a receipt"));
  expect(screen.getByRole("textbox", { name: "External LLM Response" })).toHaveValue('{"testCases":[]}');
  expect(screen.getByRole("button", { name: "Copy Prompt" })).toBeInTheDocument();
});

it("keeps pasted output while preparing a fresh prompt after a stale draft", async () => {
  mocks.externalLlmEnabled = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(session("azure-devops")));
  let draftCount = 0;
  mocks.postJson.mockImplementation(async (url: string) => {
    if (url === "/api/test-cases/manual/draft") {
      draftCount += 1;
      return { prompt: draftCount === 1 ? "Original prompt" : "Fresh prompt", promptVersion: "3.1.0", draftToken: `sealed-${draftCount}`, contextCitations: [] };
    }
    if (url === "/api/test-cases/manual/submit") throw new ApiError("Story changed. Prepare a fresh prompt.", {
      status: 409, code: AppErrorCode.AcceptanceCriteriaDraftStale,
    });
    throw new Error(`Unexpected request: ${url}`);
  });
  render(<TestCaseDesignClient />);
  fireEvent.click(screen.getByRole("button", { name: "Use External LLM" }));
  fireEvent.change(screen.getByLabelText("Work Item ID"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare Prompt" }));
  await screen.findByRole("textbox", { name: "External LLM Response" });
  fireEvent.change(screen.getByRole("textbox", { name: "External LLM Response" }), { target: { value: "My pasted response" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate and Continue" }));
  await screen.findByText(/This draft can no longer be submitted/);
  fireEvent.click(screen.getByRole("button", { name: "Prepare Prompt" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "External LLM prompt" })).toHaveValue("Fresh prompt"));
  expect(screen.getByRole("textbox", { name: "External LLM Response" })).toHaveValue("My pasted response");
});

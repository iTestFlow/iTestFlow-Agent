// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock("@/components/workflow/post-json", () => ({ postJson: api.postJson }));
vi.mock("@/components/navigation/unsaved-changes-provider", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));

import type { GeneratedTestCase, PublishRunResult } from "./test-intelligence-types";
import { PublishGeneratedCasesPanel, projectWarning } from "./test-intelligence-shared";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "project-1",
  azureProjectName: "Demo Project",
  azureOrganizationUrl: "https://dev.azure.com/demo-org",
};

function generatedCase(overrides: Partial<GeneratedTestCase> = {}): GeneratedTestCase {
  return {
    id: "TC-001",
    title: "Successful checkout",
    description: "Checkout succeeds with valid payment.",
    priority: 1,
    type: "functional",
    category: "Checkout",
    preconditions: "A customer has a cart.",
    steps: [{ stepNumber: 1, action: "Submit payment", expectedResult: "Order is created" }],
    ...overrides,
  };
}

function completeResult(overrides: Partial<PublishRunResult> = {}): PublishRunResult {
  return {
    suiteMode: "none",
    results: [{
      localId: "TC-001",
      azureTestCaseId: "1001",
      success: true,
      create: { success: true },
      link: { success: true },
    }],
    ...overrides,
  };
}

function renderPanel(testCases = [generatedCase()], onPublished = vi.fn(), providerId: string | null = "azure-devops") {
  return {
    onPublished,
    ...render(
      <PublishGeneratedCasesPanel
        scope={scope}
        targetWorkItemId="123"
        testCases={testCases}
        onPublished={onPublished}
        providerId={providerId}
      />,
    ),
  };
}

function publishButton(testCaseCount = 1) {
  return screen.getByRole("button", { name: `Publish ${testCaseCount}` });
}

function confirmPublish(testCaseCount = 1) {
  fireEvent.click(publishButton(testCaseCount));
  fireEvent.click(screen.getByRole("button", { name: "Publish cases" }));
}

function publishRequests() {
  return api.postJson.mock.calls.filter(([path]) => path === "/api/publish/test-cases");
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PublishGeneratedCasesPanel", () => {
  it("stays neutral and disables publishing while the workspace provider is unresolved", () => {
    renderPanel([generatedCase()], vi.fn(), null);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("Workspace provider is still loading. Publishing will be available when it resolves.")).toBeInTheDocument();
    expect(screen.getByText("Work item 123")).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
    expect(screen.queryByText(/Azure DevOps|user story|Story 123/i)).not.toBeInTheDocument();
  });

  it("hides the Azure requirement-suite controls for Jira projects and never fetches Azure test plans", async () => {
    api.postJson.mockImplementation((path: string) => {
      if (path === "/api/publish/test-cases") {
        return Promise.resolve(completeResult({
          results: [{
            localId: "TC-001",
            azureTestCaseId: "QA-9",
            success: true,
            create: { success: true },
            link: { success: true },
          }],
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderPanel([generatedCase()], vi.fn(), "jira-cloud");

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Create requirement-based suite for this user story")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Select Azure Test Plan" })).not.toBeInTheDocument();
    expect(screen.getByText(/configured test management backend/)).toBeInTheDocument();
    expect(screen.getByText("Issue 123")).toBeInTheDocument();
    expect(screen.getByText("Ready to create and link the selected cases to the Jira issue.")).toBeInTheDocument();

    fireEvent.click(publishButton());
    expect(screen.getByText("Jira project: Demo Project")).toBeInTheDocument();
    expect(screen.getByText("Issue: 123")).toBeInTheDocument();
    expect(screen.getByText("Each created test case will be linked to this issue.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish cases" }));
    await waitFor(() => expect(publishRequests()).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Jira QA-9")).toBeInTheDocument());
    expect(api.postJson.mock.calls.every(([path]) => path !== "/api/azure-devops/test-plans")).toBe(true);
    expect(screen.queryByText(/Azure 1001|Story 123|User story:/)).not.toBeInTheDocument();
  });

  it("keeps Azure wording and requirement-suite controls for Azure projects", async () => {
    api.postJson.mockImplementation((path: string) => {
      if (path === "/api/publish/test-cases") return Promise.resolve(completeResult());
      return Promise.resolve({ testPlans: [] });
    });

    renderPanel([generatedCase()], vi.fn(), "azure-devops");

    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByText("Create requirement-based suite for this user story")).toBeInTheDocument();
    expect(screen.getByText("Story 123")).toBeInTheDocument();
    expect(screen.getByText("Ready to create and link the selected cases without creating a test suite.")).toBeInTheDocument();

    fireEvent.click(publishButton());
    expect(screen.getByText("Project: Demo Project")).toBeInTheDocument();
    expect(screen.getByText("User story: 123")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish cases" }));
    await waitFor(() => expect(screen.getByText("Azure 1001")).toBeInTheDocument());
  });

  it("dims and locks a fully published batch through later edits until a new mount", async () => {
    const response = deferred<PublishRunResult>();
    api.postJson.mockImplementation((path: string) => {
      if (path === "/api/publish/test-cases") return response.promise;
      if (path === "/api/azure-devops/test-plans") return Promise.resolve({ testPlans: [] });
      if (path === "/api/azure-devops/test-suites") return Promise.resolve({ testSuites: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const onPublished = vi.fn();
    const view = renderPanel([generatedCase()], onPublished);

    expect(publishButton()).toBeEnabled();
    confirmPublish();
    expect(screen.getByRole("button", { name: "Publishing..." })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("button", { name: "Publishing..." })).toBeDisabled();
    expect(publishRequests()).toHaveLength(1);

    await act(async () => {
      response.resolve(completeResult());
    });

    await waitFor(() => {
      expect(publishButton()).toBeDisabled();
      expect(onPublished).toHaveBeenCalledTimes(1);
    });
    expect(publishButton()).toHaveClass("disabled:opacity-50");
    expect(publishRequests()).toHaveLength(1);

    view.rerender(
      <PublishGeneratedCasesPanel
        scope={scope}
        targetWorkItemId="123"
        testCases={[generatedCase({ title: "Updated checkout" })]}
        onPublished={onPublished}
        providerId="azure-devops"
      />,
    );
    expect(publishButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "false"));
    await waitFor(() => expect(publishButton()).toBeDisabled());

    fireEvent.click(publishButton());
    expect(publishRequests()).toHaveLength(1);

    view.unmount();
    renderPanel();
    expect(publishButton()).toBeEnabled();
  });

  it("keeps Publish enabled after a partial case failure", async () => {
    api.postJson.mockResolvedValue(completeResult({
      results: [
        {
          localId: "TC-001",
          azureTestCaseId: "1001",
          success: true,
          create: { success: true },
          link: { success: true },
        },
        {
          localId: "TC-002",
          success: false,
          create: { success: false, error: "Azure create failed" },
          link: { success: false, error: "Not attempted" },
        },
      ],
    }));
    const onPublished = vi.fn();
    renderPanel([generatedCase(), generatedCase({ id: "TC-002", title: "Declined payment" })], onPublished);

    confirmPublish(2);

    await waitFor(() => expect(screen.getByText("Publish Results: 1 of 2 completed")).toBeInTheDocument());
    expect(publishButton(2)).toBeEnabled();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("keeps Publish enabled when the requirement suite fails", async () => {
    api.postJson.mockImplementation((path: string) => {
      if (path === "/api/azure-devops/test-plans") return Promise.resolve({ testPlans: [] });
      if (path === "/api/azure-devops/test-suites") return Promise.resolve({ testSuites: [] });
      if (path === "/api/publish/test-cases") {
        return Promise.resolve(completeResult({
          suiteMode: "requirement",
          requirementSuite: { success: false, error: "Suite creation failed" },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const onPublished = vi.fn();
    renderPanel([generatedCase()], onPublished);

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(screen.getByPlaceholderText("Or paste Test Plan ID/link")).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText("Or paste Test Plan ID/link"), { target: { value: "101" } });
    await waitFor(() => expect(screen.getByPlaceholderText("Or paste Test Plan ID/link")).toHaveValue("101"));
    fireEvent.change(screen.getByPlaceholderText("Or paste Parent Suite ID/link"), { target: { value: "202" } });
    await waitFor(() => expect(screen.getByPlaceholderText("Or paste Parent Suite ID/link")).toHaveValue("202"));
    confirmPublish();

    await waitFor(() => expect(screen.getByText("Suite failed")).toBeInTheDocument());
    expect(publishButton()).toBeEnabled();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("keeps Publish enabled after a transport error", async () => {
    api.postJson.mockRejectedValue(new Error("Azure is unavailable"));
    const onPublished = vi.fn();
    renderPanel([generatedCase()], onPublished);

    confirmPublish();

    await waitFor(() => expect(screen.getAllByText("Azure is unavailable").length).toBeGreaterThan(0));
    expect(publishButton()).toBeEnabled();
    expect(onPublished).not.toHaveBeenCalled();
  });
});

describe("projectWarning", () => {
  it("uses neutral, Jira, and Azure project labels without guessing the provider", () => {
    const view = render(<>{projectWarning(null, null)}</>);
    expect(screen.getByText("Please select a project before running this action.")).toBeInTheDocument();

    view.rerender(<>{projectWarning(null, "jira-cloud")}</>);
    expect(screen.getByText("Please select a Jira project before running this action.")).toBeInTheDocument();

    view.rerender(<>{projectWarning(null, "azure-devops")}</>);
    expect(screen.getByText("Please select an Azure DevOps project before running this action.")).toBeInTheDocument();
  });
});

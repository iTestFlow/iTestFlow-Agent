// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock("@/components/workflow/post-json", () => ({ postJson: api.postJson }));

import { buildJobPollDelay, KnowledgeBuildV4 } from "./knowledge-build-v4";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "project-1",
  azureProjectName: "Knowledge Project",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

function completedJob(result: Record<string, unknown>, operation = "build") {
  return {
    id: `${operation}-job`,
    status: "completed",
    operation,
    phase: "completed",
    progress: { percent: 100 },
    result,
    cancellation: { requested: false, requestedAt: null },
    error: null,
  };
}

function conflictPage(page: number) {
  const start = (page - 1) * 50;
  return {
    draftVersion: "pkdv_test",
    counts: { total: 1_000, resolved: 0, remaining: 1_000 },
    page,
    pageSize: 50,
    pageCount: 20,
    conflicts: Array.from({ length: 50 }, (_, offset) => {
      const ordinal = start + offset + 1;
      return {
        conflictId: `conflict-${ordinal}`,
        identityKey: `identity:module:module-${ordinal}`,
        subject: `module-${ordinal}`,
        affectedCategory: "module",
        conflictType: "duplicate_identity",
        participants: [{
          participantId: `participant-${ordinal}`,
          entryKey: `module-${ordinal}`,
          fields: { name: `Module ${ordinal}`, description: `Supported statement ${ordinal}` },
          evidence: [{
            sourceField: "description",
            quote: `Supported statement ${ordinal}`,
            sourceWorkItemId: `${ordinal}`,
          }],
        }],
      };
    }),
  };
}

function draftPreview() {
  return {
    draftId: "draft-1",
    draftVersion: "pkdv_test",
    status: "ready_to_publish",
    counts: {
      all: 1,
      module: 0,
      business_rule: 0,
      state_transition: 0,
      glossary: 0,
      dependency: 1,
    },
    filters: { category: "all", query: "" },
    page: 1,
    pageSize: 10,
    pageCount: 1,
    total: 1,
    entries: [{
      entryId: "dependency:0:checkout-payment-gateway",
      category: "dependency",
      categoryLabel: "Dependencies",
      badge: "Dependency",
      title: "Checkout → Payment Gateway",
      fields: [
        {
          id: "id",
          label: "ID",
          value: "dep-checkout-payment-gateway",
        },
        {
          id: "dependencyType",
          label: "Dependency type",
          value: "external service dependency",
        },
      ],
      sourceWorkItemIds: ["15"],
      evidence: [{
        sourceWorkItemId: "15",
        sourceField: "acceptanceCriteria",
        quote: "Payment gateway is called.",
      }],
    }],
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Project Knowledge v4 conflict review", () => {
  it("requires the project index before starting automatic or external builds", () => {
    const { rerender } = render(
      <KnowledgeBuildV4
        scope={scope}
        sourceIndexReady={false}
        onPublished={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: "Build knowledge" })).toBeDisabled();
    expect(screen.getByText("Load the project index above before building knowledge.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Generate knowledge draft" }).className).toContain("border-border");
    expect(screen.getByRole("navigation", { name: "Build Knowledge workflow" })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Load Project Index, step 1 of 4, current step/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Generate Knowledge Draft, step 2 of 4, locked/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "External LLM" }));
    expect(screen.getByRole("button", { name: "Prepare prompt" })).toBeDisabled();
    expect(screen.getByText("Load the project index above before preparing an external prompt.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Use an external LLM" }).className).toContain("border-border");

    rerender(
      <KnowledgeBuildV4
        scope={scope}
        sourceIndexReady
        onPublished={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: "Prepare prompt" })).not.toBeDisabled();
    expect(screen.getByRole("group", { name: /Load Project Index, step 1 of 4, completed/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Generate Knowledge Draft, step 2 of 4, current step/ })).toBeTruthy();
  });

  it("restores Incremental and Full recompile controls and queues the selected mode", async () => {
    api.postJson.mockResolvedValue({
      job: completedJob({ outcome: "no_changes" }),
      reused: false,
    });

    render(<KnowledgeBuildV4 scope={scope} onPublished={vi.fn().mockResolvedValue(undefined)} />);

    const incremental = screen.getByRole("button", { name: "Incremental" });
    const full = screen.getByRole("button", { name: "Full recompile" });
    expect(incremental.getAttribute("aria-pressed")).toBe("true");
    expect(full.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(full);
    expect(full.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Build knowledge" }));

    await waitFor(() => expect(api.postJson).toHaveBeenCalledWith(
      "/api/context/knowledge/jobs",
      expect.objectContaining({ operation: "build", mode: "full" }),
    ));
  });

  it("uses the shared LLM progress and loading-game experience for active builds", async () => {
    api.postJson.mockResolvedValue({
      job: {
        id: "build-job",
        status: "pending",
        operation: "build",
        phase: "queued",
        progress: {},
        result: null,
        cancellation: { requested: false, requestedAt: null },
        error: null,
        createdAt: new Date().toISOString(),
      },
      reused: false,
    });

    render(<KnowledgeBuildV4 scope={scope} onPublished={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByText(/frozen draft/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Build knowledge" }));

    await waitFor(() => expect(screen.getByText("Building project knowledge")).toBeTruthy());
    expect(screen.getByText("Waiting for generation capacity.")).toBeTruthy();
    expect(screen.queryByText("Queued. 0% complete.")).toBeNull();
    expect(screen.getByRole("button", { name: "Play while waiting?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeTruthy();
    expect(screen.getByText(/generation will continue safely/)).toBeTruthy();
  });

  it("renders only 50 cards at once from a 1,000-conflict fixture", async () => {
    api.postJson.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/context/knowledge/jobs") {
        return {
          job: completedJob({
            outcome: "conflicts_required",
            draftId: "draft-1",
            conflictCount: 1_000,
          }),
          reused: false,
        };
      }
      if (url.endsWith("/conflicts")) return conflictPage(Number(body.page));
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<KnowledgeBuildV4 scope={scope} onPublished={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Build knowledge" }));

    await waitFor(() => {
      expect(screen.getByText("Page 1 of 20")).toBeTruthy();
      expect(screen.getAllByRole("article")).toHaveLength(50);
    });
    expect(screen.getByRole("group", { name: /Resolve Conflicts, step 3 of 5, current step/ })).toBeTruthy();
    expect(screen.getByText("1000 unresolved")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "1000 knowledge conflicts need review before publishing" })).toBeTruthy();
    const conflictCall = api.postJson.mock.calls.find(([url]) => String(url).endsWith("/conflicts"));
    expect(conflictCall?.[1]).toMatchObject({ page: 1, pageSize: 50 });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(screen.getByText("Page 2 of 20")).toBeTruthy();
      expect(screen.getAllByRole("article")).toHaveLength(50);
    });
  });

  it("keeps cross-page selections locally and posts identifiers only", async () => {
    const twoConflictPage = (page: number) => {
      const item = conflictPage(1).conflicts[page - 1];
      return {
        draftVersion: "pkdv_test",
        counts: { total: 2, resolved: 0, remaining: 2 },
        page,
        pageSize: 1,
        pageCount: 2,
        conflicts: [item],
      };
    };
    api.postJson.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/context/knowledge/jobs") {
        return {
          job: completedJob({ outcome: "conflicts_required", draftId: "draft-1", conflictCount: 2 }),
          reused: false,
        };
      }
      if (url.endsWith("/conflicts")) return twoConflictPage(Number(body.page));
      if (url.endsWith("/decisions")) {
        return { outcome: "ready_to_publish", draftId: "draft-1" };
      }
      if (url.endsWith("/preview")) return draftPreview();
      if (url.endsWith("/publish")) {
        return { outcome: "published", draftId: "draft-1", freshness: "current" };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<KnowledgeBuildV4 scope={scope} onPublished={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Build knowledge" }));

    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Keep version 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Keep version 1" }));

    expect(screen.getByText(/2 decided locally/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply decisions" }));

    await waitFor(() => expect(api.postJson.mock.calls.some(([url]) =>
      String(url).endsWith("/decisions"),
    )).toBe(true));
    const decisionCall = api.postJson.mock.calls.find(([url]) => String(url).endsWith("/decisions"));
    const payload = decisionCall?.[1] as {
      scope: typeof scope;
      draftVersion: string;
      decisions: Array<Record<string, unknown>>;
    };
    expect(payload.scope).toEqual(scope);
    expect(payload.draftVersion).toBe("pkdv_test");
    expect(payload.decisions).toHaveLength(2);
    expect(payload.decisions[0]).toEqual({
      conflictId: "conflict-1",
      action: "keep",
      participantId: "participant-1",
    });
    expect(payload.decisions[1]).toEqual({
      conflictId: "conflict-2",
      action: "keep",
      participantId: "participant-2",
    });
    expect(payload.decisions.every((decision) =>
      Object.keys(decision).every((key) => ["conflictId", "action", "participantId", "fieldParticipants"].includes(key)),
    )).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/knowledgeBase|proposedKnowledge|evidenceRefs|sourceSnapshotId/);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Review Knowledge Draft" })).toBeTruthy();
      expect(screen.getByText("external service dependency")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled();
    });
    expect(screen.queryByText("Dependency type")).toBeNull();
    expect(screen.queryByText("dep-checkout-payment-gateway")).toBeNull();
    expect(screen.queryByText(/Payment gateway is called\./)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Show details for Checkout/ }));

    expect(screen.getByRole("button", { name: /^Hide details for Checkout/ })).toBeTruthy();
    expect(screen.getByText("Dependency type")).toBeTruthy();
    expect(screen.getByText("dep-checkout-payment-gateway")).toBeTruthy();
    expect(screen.getByText(/Payment gateway is called\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled();
    expect(screen.getByRole("group", { name: /Resolve Conflicts, step 3 of 5, completed/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Review Knowledge Draft, step 4 of 5, current step/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(api.postJson).toHaveBeenCalledWith(
      "/api/context/knowledge/drafts/draft-1/publish",
      { scope },
    ));
    expect(api.postJson.mock.calls.filter(([url]) => url === "/api/context/knowledge/jobs")).toHaveLength(1);
  });

  it("keeps draft category visuals, filtering, search, pagination, and responsive containment in sync", async () => {
    const counts = {
      all: 12,
      module: 5,
      business_rule: 2,
      state_transition: 1,
      glossary: 3,
      dependency: 1,
    };
    api.postJson.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/context/knowledge/jobs") {
        return {
          job: completedJob({ outcome: "ready_to_publish", draftId: "draft-1" }),
          reused: false,
        };
      }
      if (url.endsWith("/preview")) {
        const page = Number(body.page ?? 1);
        return {
          ...draftPreview(),
          counts,
          filters: {
            category: String(body.category ?? "all"),
            query: String(body.query ?? ""),
          },
          page,
          pageCount: 2,
          total: 12,
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<KnowledgeBuildV4 scope={scope} onPublished={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Build knowledge" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /All\s*12/i })).toBeTruthy());
    const categoryGroup = screen.getByRole("group", { name: "Draft knowledge categories" });
    const expectedCategories = [
      ["All", 12, "all"],
      ["Modules", 5, "module"],
      ["Business Rules", 2, "businessRule"],
      ["State Transitions", 1, "stateTransition"],
      ["Glossary", 3, "glossary"],
      ["Dependencies", 1, "dependency"],
    ] as const;

    for (const [label, count, iconKey] of expectedCategories) {
      const button = within(categoryGroup).getByRole("button", { name: new RegExp(`${label}\\s*${count}`, "i") });
      const icon = button.querySelector(`svg[data-knowledge-category-icon="${iconKey}"]`);
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
    }

    const allButton = within(categoryGroup).getByRole("button", { name: /All\s*12/i });
    const dependenciesButton = within(categoryGroup).getByRole("button", { name: /Dependencies\s*1/i });
    expect(allButton).toHaveAttribute("aria-pressed", "true");
    expect(dependenciesButton).toHaveAttribute("aria-pressed", "false");

    const resultRegion = screen.getByRole("region", { name: "Review Knowledge Draft" });
    expect(resultRegion).toHaveClass("min-w-0", "max-w-full");
    expect(resultRegion.parentElement).toHaveClass("grid-cols-[minmax(0,1fr)]");
    expect(categoryGroup).toHaveClass("min-w-0", "max-w-full");
    expect(resultRegion.closest('[data-slot="card-content"]')).toHaveClass("min-w-0", "max-w-full");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.postJson.mock.calls.some(([url, body]) =>
      String(url).endsWith("/preview") && (body as Record<string, unknown>).page === 2,
    )).toBe(true));

    fireEvent.click(dependenciesButton);
    await waitFor(() => expect(api.postJson.mock.calls.some(([url, body]) => {
      const request = body as Record<string, unknown>;
      return String(url).endsWith("/preview") && request.category === "dependency" && request.page === 1;
    })).toBe(true));
    expect(dependenciesButton).toHaveAttribute("aria-pressed", "true");
    expect(allButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.change(screen.getByRole("textbox", { name: "Search knowledge draft" }), {
      target: { value: "  payment gateway  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.postJson.mock.calls.some(([url, body]) => {
      const request = body as Record<string, unknown>;
      return String(url).endsWith("/preview") &&
        request.category === "dependency" &&
        request.query === "payment gateway" &&
        request.page === 1;
    })).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled());
  });

  it("shows non-blocking possible tensions for a ready-to-publish draft", async () => {
    api.postJson.mockImplementation(async (url: string) => {
      if (url === "/api/context/knowledge/jobs") {
        return {
          job: completedJob({ outcome: "ready_to_publish", draftId: "draft-1", possibleTensionCount: 1 }),
          reused: false,
        };
      }
      if (url.endsWith("/conflicts")) {
        return {
          draftVersion: "pkdv_test",
          counts: { total: 0, resolved: 0, remaining: 0 },
          page: 1,
          pageSize: 50,
          pageCount: 1,
          conflicts: [],
          possibleTensions: [{
            category: "business_rule",
            subject: "identity:business_rule:purchase-notification",
            entryKeys: ["notification", "notification-a1b2c3d4"],
            reason: "different_atomic_identity",
          }],
        };
      }
      if (url.endsWith("/preview")) return draftPreview();
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<KnowledgeBuildV4 scope={scope} onPublished={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Build knowledge" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "No blocking knowledge conflicts" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/These entries were kept separately/)).toBeTruthy());
    expect(screen.getByRole("region", { name: "Possible tensions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply decisions" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Review Knowledge Draft" })).toBeTruthy();
  });

  it("uses bounded adaptive polling delays", () => {
    const createdAt = "2026-07-16T00:00:00.000Z";
    const job = { createdAt };
    expect(buildJobPollDelay(job, 0, Date.parse(createdAt) + 5_000)).toBe(2_000);
    expect(buildJobPollDelay(job, 0, Date.parse(createdAt) + 30_000)).toBe(5_000);
    expect(buildJobPollDelay(job, 0, Date.parse(createdAt) + 10 * 60_000)).toBe(15_000);
    expect(buildJobPollDelay(job, 1, Date.parse(createdAt))).toBe(5_000);
    expect(buildJobPollDelay(job, 2, Date.parse(createdAt))).toBe(15_000);
    expect(buildJobPollDelay(job, 3, Date.parse(createdAt))).toBe(30_000);

    let now = Date.parse(createdAt);
    let requestCount = 0;
    const end = now + 10 * 60_000;
    while (now < end) {
      now += buildJobPollDelay(job, 0, now);
      requestCount += 1;
    }
    expect(requestCount).toBeLessThanOrEqual(65);
  });
});

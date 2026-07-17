// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAzureWorkItemUrl,
  BusinessOwnerAssistantClient,
  organizationLabel,
  readinessStatus,
} from "./business-owner-assistant-client";

vi.mock("@/components/navigation/unsaved-changes-provider", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const scope = {
  projectId: "project-1",
  azureProjectId: "project-1",
  azureProjectName: "Demo Project",
  azureOrganizationUrl: "https://dev.azure.com/demo-org",
  workspaceId: "workspace-1",
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const defaultCitations = [{
  sourceType: "project_context",
  sourceId: "WI:123",
  title: "Approval workflow",
  workItemId: "123",
  workItemType: "User Story",
}];

function installFetch(options?: {
  statusFailure?: boolean;
  answer?: string;
  citations?: typeof defaultCitations;
  retrievedContextCount?: number;
  retrievedKnowledgeCount?: number;
  linkedWorkItemCount?: number;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    const url = String(input);
    if (url === "/api/context/status") {
      if (options?.statusFailure) throw new Error("Status failed");
      return jsonResponse({
        totalCount: 7,
        items: [{ lastIndexedAt: "2026-07-01T10:00:00.000Z" }],
      });
    }
    if (url === "/api/context/knowledge/status") {
      if (options?.statusFailure) throw new Error("Status failed");
      return jsonResponse({
        snapshot: {
          extractedAt: "2026-07-01T11:00:00.000Z",
          updatedAt: "2026-07-01T11:00:00.000Z",
          knowledgeBase: {
            modules: [{}],
            businessRules: [{}],
            stateTransitions: [],
            glossary: [{}],
            crossDependencies: [],
          },
        },
      });
    }
    if (url === "/api/context-chatbot/message") {
      const citations = options?.citations ?? defaultCitations;
      return jsonResponse({
        answer: options?.answer ?? "The approval rule is grounded in [WI:123]. Unknown text [UNKNOWN] stays plain.",
        citations,
        retrievedContextCount: options?.retrievedContextCount ?? citations.length,
        retrievedKnowledgeCount: options?.retrievedKnowledgeCount ?? 0,
        linkedWorkItemCount: options?.linkedWorkItemCount ?? 0,
        provider: "test-provider",
        model: "test-model",
      });
    }
    if (url === "/api/context/knowledge/promote") return jsonResponse({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("BusinessOwnerAssistantClient", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("itestflow.activeProject", JSON.stringify(scope));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows project readiness and submits the featured project overview immediately", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();

    render(<BusinessOwnerAssistantClient workspaceRole="owner" />);

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("7 work items")).toBeInTheDocument();
    expect(screen.getByText("3 knowledge items")).toBeInTheDocument();
    expect(screen.getByText("demo-org · Azure DevOps")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Main business rules/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Project overview/i }));

    expect(await screen.findByText(/approval rule is grounded/i)).toBeInTheDocument();
    const chatCall = fetchMock.mock.calls.find(([url]) => url === "/api/context-chatbot/message");
    expect(chatCall).toBeDefined();
    expect(JSON.parse(String((chatCall?.[1] as RequestInit).body))).toMatchObject({
      message: "Give me a concise overview of this project, including its purpose, main modules, key workflows, important business rules, roles, and dependencies. Clearly identify anything the indexed sources do not explain.",
      history: [],
    });
    expect(screen.getByRole("button", { name: "Sources (1)" })).toBeInTheDocument();
    expect(screen.getByText("Based on 1 project source")).toBeInTheDocument();
    expect(screen.getByText("test-provider / test-model").closest("details")).not.toHaveAttribute("open");
  });

  it("reports 'Based on N project sources' matching the full citation list, broken down by bucket", async () => {
    // The citations list can include work items fanned out from a knowledge entry's
    // provenance (see buildCitations in context-chatbot.service.ts) so those inline
    // mentions are clickable, on top of what was directly retrieved. "Based on N"
    // must count all of it (retrieved context + saved knowledge + linked work items)
    // so it always matches "Sources (N)" instead of silently under-reporting.
    const manyCitations = Array.from({ length: 3 }, (_, index) => ({
      sourceType: "project_context" as const,
      sourceId: `WI:${index}`,
      title: `Work item ${index}`,
      workItemId: String(index),
      workItemType: "User Story",
    }));
    installFetch({
      answer: "Grounded in indexed and saved sources.",
      citations: manyCitations,
      retrievedContextCount: 1,
      retrievedKnowledgeCount: 1,
      linkedWorkItemCount: 1,
    });
    const user = userEvent.setup();
    render(<BusinessOwnerAssistantClient workspaceRole="owner" />);

    await user.click(await screen.findByRole("button", { name: /Project overview/i }));
    await screen.findByText(/Grounded in indexed and saved sources/i);

    expect(screen.getByRole("button", { name: "Sources (3)" })).toBeInTheDocument();
    expect(screen.getByText("Based on 3 project sources")).toBeInTheDocument();

    await user.click(screen.getByText("Based on 3 project sources"));
    expect(screen.getByText("Linked work items")).toBeInTheDocument();
  });

  it("opens inline source details and builds an encoded Azure DevOps link", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<BusinessOwnerAssistantClient workspaceRole="member" />);

    await user.click(await screen.findByRole("button", { name: /Main business rules/i }));
    expect(screen.getByText((_, element) => (
      element?.tagName === "P" && element.textContent?.includes("[UNKNOWN]") === true
    ))).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "View source WI:123" }));

    expect(screen.getByRole("heading", { name: "Source details" })).toBeInTheDocument();
    const sourceLink = screen.getByRole("link", { name: "Open work item 123 in Azure DevOps" });
    expect(sourceLink).toHaveAttribute(
      "href",
      "https://dev.azure.com/demo-org/Demo%20Project/_workitems/edit/123",
    );
    expect(screen.queryByRole("button", { name: "Save insight" })).not.toBeInTheDocument();
  });

  it("turns parenthesized source ID runs into inline source buttons", async () => {
    installFetch({
      answer: "Payment and policy issuance are supported by provider calls (WI:123, WI:456). Unknown WI:999 stays plain.",
      citations: [
        defaultCitations[0],
        {
          sourceType: "project_context",
          sourceId: "WI:456",
          title: "Policy issuance",
          workItemId: "456",
          workItemType: "Feature",
        },
      ],
    });
    const user = userEvent.setup();
    render(<BusinessOwnerAssistantClient workspaceRole="member" />);

    await user.click(await screen.findByRole("button", { name: /Main business rules/i }));

    expect(await screen.findByRole("button", { name: "View source WI:123" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View source WI:456" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View source WI:999" })).not.toBeInTheDocument();
    expect(screen.getByText((_, element) => (
      element?.tagName === "P" && element.textContent?.includes("Unknown WI:999 stays plain") === true
    ))).toBeInTheDocument();
  });

  it("confirms before starting a new chat", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<BusinessOwnerAssistantClient workspaceRole="owner" />);

    const newChat = screen.getByRole("button", { name: "New chat" });
    expect(newChat).toBeDisabled();

    await user.click(await screen.findByRole("button", { name: /Main business rules/i }));
    await screen.findByText(/approval rule is grounded/i);
    expect(newChat).toBeEnabled();

    await user.click(newChat);
    expect(screen.getByRole("heading", { name: "Start a new chat?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep conversation" }));
    expect(screen.getByText(/approval rule is grounded/i)).toBeInTheDocument();

    await user.click(newChat);
    await user.click(screen.getByRole("button", { name: "Start new chat" }));
    expect(await screen.findByText("What would you like to understand?")).toBeInTheDocument();
    expect(newChat).toBeDisabled();
  });

  it("keeps chat usable when readiness status cannot be loaded", async () => {
    installFetch({ statusFailure: true });
    const user = userEvent.setup();
    render(<BusinessOwnerAssistantClient workspaceRole="member" />);

    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
    const input = screen.getByLabelText("Ask the Business Owner Assistant about this project");
    await user.type(input, "Explain approvals");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(/approval rule is grounded/i)).toBeInTheDocument();
  });
});

describe("business owner assistant helpers", () => {
  it("classifies all readiness combinations", () => {
    expect(readinessStatus(1, 1)).toBe("ready");
    expect(readinessStatus(1, 0)).toBe("context-only");
    expect(readinessStatus(0, 1)).toBe("knowledge-only");
    expect(readinessStatus(0, 0)).toBe("empty");
  });

  it("formats organization labels and work-item URLs", () => {
    expect(organizationLabel("https://dev.azure.com/example")).toBe("example · Azure DevOps");
    expect(organizationLabel("https://legacy.visualstudio.com")).toBe("legacy · Azure DevOps");
    expect(buildAzureWorkItemUrl(scope, "WI 42")).toBe(
      "https://dev.azure.com/demo-org/Demo%20Project/_workitems/edit/WI%2042",
    );
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoryAttachmentsPanel } from "./story-attachments-panel";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "project-1",
  azureProjectName: "Demo",
  azureOrganizationUrl: "https://dev.azure.com/demo",
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();
let uploadFailures: Array<{ clientIndex: number; fileName: string; error: string }> = [];
let savedAttachmentResponses: unknown[][] | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  uploadFailures = [];
  savedAttachmentResponses = null;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/story-attachments?")) {
      return json({
        attachments: savedAttachmentResponses?.shift() ?? [
          {
            id: "attachment-ready",
            originalFileName: "design.png",
            mimeType: "image/png",
            byteSize: 42,
            parseStatus: "parsed",
            source: { kind: "upload" },
          },
          {
            id: "attachment-pending",
            originalFileName: "brief.pdf",
            mimeType: "application/pdf",
            byteSize: 84,
            parseStatus: "pending",
            source: { kind: "jira_attachment" },
          },
        ],
      });
    }
    if (url.startsWith("/api/story-attachments/source?")) {
      return json({
        attachments: [{
          id: "source-1",
          fileName: "linked-design.png",
          contentType: "image/png",
          size: 32,
        }],
      });
    }
    if (url === "/api/story-attachments/import" && init?.method === "POST") return json({ attachment: {} });
    if (url === "/api/story-attachments" && init?.method === "POST") return json({ uploads: [{}], failures: uploadFailures });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StoryAttachmentsPanel", () => {
  it("allows ready attachments to be selected and keeps processing files unavailable", async () => {
    const onSelectedAttachmentIdsChange = vi.fn();
    render(
      <StoryAttachmentsPanel
        scope={scope}
        targetWorkItemId="123"
        selectedAttachmentIds={[]}
        onSelectedAttachmentIdsChange={onSelectedAttachmentIdsChange}
        onAttachmentsChanged={vi.fn()}
      />,
    );

    const ready = await screen.findByRole("checkbox", { name: "Include design.png in this run" });
    expect(screen.getByRole("checkbox", { name: "Include brief.pdf in this run" })).toBeDisabled();

    fireEvent.click(ready);
    expect(onSelectedAttachmentIdsChange).toHaveBeenCalledWith(["attachment-ready"]);
  });

  it("silently refreshes while an attachment is processing", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    savedAttachmentResponses = [
      [{
        id: "attachment-processing",
        originalFileName: "wireframe.png",
        mimeType: "image/png",
        byteSize: 166 * 1024,
        parseStatus: "parsing",
        source: { kind: "upload" },
      }],
      [{
        id: "attachment-processing",
        originalFileName: "wireframe.png",
        mimeType: "image/png",
        byteSize: 166 * 1024,
        parseStatus: "parsed",
        source: { kind: "upload" },
      }],
    ];
    render(
      <StoryAttachmentsPanel
        scope={scope}
        targetWorkItemId="123"
        selectedAttachmentIds={[]}
        onSelectedAttachmentIdsChange={vi.fn()}
        onAttachmentsChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText("Processing")).toBeInTheDocument();
    const poll = intervalSpy.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
    expect(poll).toEqual(expect.any(Function));
    await act(async () => {
      (poll as () => void)();
    });
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uploads files with story fields before files and refreshes the saved list", async () => {
    const onAttachmentsChanged = vi.fn();
    render(
      <StoryAttachmentsPanel
        scope={scope}
        targetWorkItemId="123"
        selectedAttachmentIds={[]}
        onSelectedAttachmentIdsChange={vi.fn()}
        onAttachmentsChanged={onAttachmentsChanged}
      />,
    );
    await screen.findByText("design.png");

    fireEvent.change(screen.getByLabelText("Upload files for AI context"), {
      target: { files: [new File(["# Design"], "design.md", { type: "text/markdown" })] },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/story-attachments", expect.objectContaining({ method: "POST" })));
    const uploadCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/story-attachments" && (init as RequestInit | undefined)?.method === "POST");
    const formData = (uploadCall?.[1] as RequestInit).body as FormData;
    expect(Array.from(formData.entries()).map(([key, value]) => `${key}:${typeof value === "string" ? value : value.name}`)).toEqual([
      `scope:${JSON.stringify(scope)}`,
      "workItemId:123",
      "files:design.md",
    ]);
    expect(onAttachmentsChanged).toHaveBeenCalledOnce();
  });

  it("reports individual failures when a multipart upload only partly succeeds", async () => {
    uploadFailures = [{ clientIndex: 1, fileName: "unsupported.exe", error: "Unsupported file type" }];
    render(
      <StoryAttachmentsPanel
        scope={scope}
        targetWorkItemId="123"
        selectedAttachmentIds={[]}
        onSelectedAttachmentIdsChange={vi.fn()}
        onAttachmentsChanged={vi.fn()}
      />,
    );
    await screen.findByText("design.png");

    fireEvent.change(screen.getByLabelText("Upload files for AI context"), {
      target: { files: [new File(["test"], "valid.txt", { type: "text/plain" }), new File(["bad"], "unsupported.exe")] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("1 file could not be added: unsupported.exe");
  });

  it("imports a linked work-item file into the saved attachment list", async () => {
    const onAttachmentsChanged = vi.fn();
    render(
      <StoryAttachmentsPanel
        scope={scope}
        targetWorkItemId="123"
        selectedAttachmentIds={[]}
        onSelectedAttachmentIdsChange={vi.fn()}
        onAttachmentsChanged={onAttachmentsChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Import linked files" }));
    await screen.findByText("linked-design.png");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/story-attachments/import",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("source-1") }),
    ));
    expect(onAttachmentsChanged).toHaveBeenCalledOnce();
  });
});

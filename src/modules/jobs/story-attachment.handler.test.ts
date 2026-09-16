import { expect, it, vi } from "vitest";

import type { Job } from "./job-queue.service";

const mocks = vi.hoisted(() => ({
  beginStoryAttachmentParse: vi.fn(),
  completeStoryAttachmentParse: vi.fn(),
  completeStoryAttachmentStorageCleanup: vi.fn(),
  failStoryAttachmentParse: vi.fn(),
  getStoryAttachmentCleanupTarget: vi.fn(),
  read: vi.fn(),
  putVisual: vi.fn(),
  deleteAttachmentTree: vi.fn(),
  deleteVisualGeneration: vi.fn(),
  deleteVisualGenerationsBefore: vi.fn(),
  parseDocument: vi.fn(),
  extractStoryAttachmentVisuals: vi.fn(),
}));

vi.mock("@/modules/documents/document-parser-registry", () => ({
  DOCUMENT_PARSE_RECIPE_VERSION: "story-attachment-test",
  parseDocument: mocks.parseDocument,
}));
vi.mock("@/modules/documents/parsed-document.types", () => ({
  isDocumentParseError: (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code),
}));
vi.mock("@/modules/story-attachments/story-attachments.service", () => ({
  beginStoryAttachmentParse: mocks.beginStoryAttachmentParse,
  completeStoryAttachmentParse: mocks.completeStoryAttachmentParse,
  completeStoryAttachmentStorageCleanup: mocks.completeStoryAttachmentStorageCleanup,
  failStoryAttachmentParse: mocks.failStoryAttachmentParse,
  getStoryAttachmentCleanupTarget: mocks.getStoryAttachmentCleanupTarget,
  getStoryAttachmentStorage: () => ({
    read: mocks.read,
    putVisual: mocks.putVisual,
    deleteAttachmentTree: mocks.deleteAttachmentTree,
    deleteVisualGeneration: mocks.deleteVisualGeneration,
    deleteVisualGenerationsBefore: mocks.deleteVisualGenerationsBefore,
  }),
}));
vi.mock("@/modules/story-attachments/story-attachment-visuals", () => ({
  extractStoryAttachmentVisuals: mocks.extractStoryAttachmentVisuals,
}));

import { runStoryAttachmentParseJob } from "./story-attachment.handler";

it("persists parsed text plus original and derived visuals in one attachment generation", async () => {
  const now = new Date().toISOString();
  mocks.beginStoryAttachmentParse.mockResolvedValue({
    id: "attachment-1",
    storageKey: "attachments/attachment-1/original",
    parseGeneration: 2,
    fileFormat: "pdf",
    mimeType: "application/pdf",
    originalFileName: "wireframe.pdf",
  });
  mocks.read.mockResolvedValue(Buffer.from("pdf bytes"));
  mocks.parseDocument.mockResolvedValue({
    status: "parsed",
    sections: [{ sectionKey: "page-1", kind: "page", text: "Checkout form", pageNumber: 1 }],
    warnings: [],
    documentMetadata: { format: "pdf", extractedTextChars: 13 },
  });
  mocks.extractStoryAttachmentVisuals.mockResolvedValue({
    warnings: [],
    visuals: [
      { source: "original", sourceLocator: "original", mimeType: "image/png", data: Buffer.from("original"), byteSize: 8, width: 10, height: 10 },
      { source: "pdf_page", sourceLocator: "page-1", mimeType: "image/jpeg", data: Buffer.from("rendered"), byteSize: 8, width: 20, height: 30 },
    ],
  });
  mocks.putVisual.mockResolvedValue({ storageKey: "attachments/attachment-1/derived/2/1.jpg", byteSize: 8 });
  mocks.completeStoryAttachmentParse.mockResolvedValue(true);

  const job = {
    id: "job-1", workspaceId: "workspace-1", projectId: "project-1", jobType: "story_attachment_parse",
    payload: { attachmentId: "attachment-1", parseGeneration: 2 }, dedupeKey: null, status: "pending",
    priority: 0, attempts: 0, maxAttempts: 3, lockedBy: null, lockedAt: null, runAfter: now,
    errorMessage: null, createdByUserId: "user-1", createdAt: now, updatedAt: now,
  } as Job;

  const result = await runStoryAttachmentParseJob(job, {
    workerId: "worker-1",
    signal: new AbortController().signal,
    updateProgress: vi.fn(async () => undefined),
  });

  expect(result).toMatchObject({ outcome: "parsed", visualCount: 2 });
  expect(mocks.deleteVisualGenerationsBefore).toHaveBeenCalledWith("attachment-1", 2);
  expect(mocks.putVisual).toHaveBeenCalledWith(expect.objectContaining({
    attachmentId: "attachment-1", parseGeneration: 2, ordinal: 1, mimeType: "image/jpeg",
  }));
  expect(mocks.completeStoryAttachmentParse).toHaveBeenCalledWith(expect.objectContaining({
    attachmentId: "attachment-1",
    parseGeneration: 2,
    parsedText: "[page-1]\nCheckout form",
    visuals: [
      expect.objectContaining({ storageKey: "attachments/attachment-1/original", source: "original" }),
      expect.objectContaining({ storageKey: "attachments/attachment-1/derived/2/1.jpg", source: "pdf_page" }),
    ],
  }));
});

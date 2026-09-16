import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readStoryAttachmentForAi: vi.fn(),
}));

vi.mock("./story-attachments.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./story-attachments.service")>()),
  readStoryAttachmentForAi: mocks.readStoryAttachmentForAi,
}));

import { loadSelectedStoryAttachmentWorkflowContext } from "./story-attachment-workflow-context";

const scope = {
  workspaceId: "ws-1", projectId: "project-1", providerId: "jira-cloud" as const,
  canonicalStoryId: "10001", storyDisplayKey: "PAY-123",
};

describe("selected story attachment workflow context", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds textual citations and native image inputs without exposing image bytes in warnings", async () => {
    const png = Buffer.from("image-bytes");
    mocks.readStoryAttachmentForAi.mockResolvedValue({
      attachment: { id: "story_attachment_1", originalFileName: "design.png", mimeType: "image/png" },
      text: "The confirmation button is disabled until the amount is accepted.",
      sections: [],
      visuals: [{ mimeType: "image/png", data: png, width: 40, height: 20, source: "original", sourceLocator: "original" }],
    });

    const result = await loadSelectedStoryAttachmentWorkflowContext({
      scope,
      attachmentIds: ["story_attachment_1"],
      includeVisuals: true,
    });

    expect(result.promptAttachments).toEqual([{
      id: "story_attachment_1",
      fileName: "design.png",
      mimeType: "image/png",
      text: "The confirmation button is disabled until the amount is accepted.",
      visualCount: 1,
    }]);
    expect(result.images).toEqual([{ mediaType: "image/png", data: png.toString("base64") }]);
    expect(result.citationAttachments).toEqual([{
      id: "story_attachment_1", fileName: "design.png", mimeType: "image/png", visualCount: 1,
    }]);
    expect(result.warnings.join("\n")).not.toContain(png.toString("base64"));
  });

  it("keeps visual bytes out of manual prompt context while preserving parsed text", async () => {
    mocks.readStoryAttachmentForAi.mockResolvedValue({
      attachment: { id: "story_attachment_1", originalFileName: "design.png", mimeType: "image/png" },
      text: "Visible label: Confirm amount.", sections: [],
      visuals: [{ mimeType: "image/png", data: Buffer.from("image-bytes"), width: 40, height: 20, source: "original", sourceLocator: "original" }],
    });

    const result = await loadSelectedStoryAttachmentWorkflowContext({ scope, attachmentIds: ["story_attachment_1"], includeVisuals: false });

    expect(result.images).toEqual([]);
    expect(result.promptAttachments[0]).toMatchObject({ text: "Visible label: Confirm amount.", visualCount: 0 });
    expect(result.warnings).toEqual([
      "Visual attachment content is not embedded in copied prompts. To have an external LLM inspect it, upload the selected files to that external LLM as well.",
    ]);
  });

  it("does not warn when a manual prompt has only textual attachment context", async () => {
    mocks.readStoryAttachmentForAi.mockResolvedValue({
      attachment: { id: "story_attachment_1", originalFileName: "notes.txt", mimeType: "text/plain" },
      text: "The amount field accepts whole numbers.", sections: [], visuals: [],
    });

    const result = await loadSelectedStoryAttachmentWorkflowContext({ scope, attachmentIds: ["story_attachment_1"], includeVisuals: false });

    expect(result.promptAttachments).toMatchObject([{ text: "The amount field accepts whole numbers." }]);
    expect(result.warnings).toEqual([]);
  });

  it("bounds visual inputs and reserves enough of the configured window for the text prompt", async () => {
    const oversizedScreenshot = await sharp({
      create: { width: 2_400, height: 2_400, channels: 3, background: "#336699" },
    }).png().toBuffer();
    const originalCopy = Buffer.from(oversizedScreenshot);
    const secondScreenshot = await sharp({
      create: { width: 1_600, height: 1_600, channels: 3, background: "#993366" },
    }).png().toBuffer();
    mocks.readStoryAttachmentForAi.mockResolvedValue({
      attachment: { id: "story_attachment_1", originalFileName: "design.png", mimeType: "image/png" },
      text: "The confirmation button is disabled until the amount is accepted.", sections: [],
      visuals: [
        { mimeType: "image/png", data: oversizedScreenshot, width: 2_400, height: 2_400, source: "original", sourceLocator: "original" },
        { mimeType: "image/png", data: secondScreenshot, width: 1_600, height: 1_600, source: "original", sourceLocator: "alternate" },
      ],
    });

    const result = await loadSelectedStoryAttachmentWorkflowContext({
      scope,
      attachmentIds: ["story_attachment_1"],
      includeVisuals: true,
      maxInputTokens: 10_000,
    });

    expect(oversizedScreenshot).toEqual(originalCopy);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mediaType).toBe("image/jpeg");
    await expect(sharp(Buffer.from(result.images[0]!.data, "base64")).metadata()).resolves.toMatchObject({
      format: "jpeg", width: 1_600, height: 1_600,
    });
    expect(result.imageTokenReserve).toBe(4_096);
    expect(result.effectivePromptInputTokens).toBe(5_904);
    expect(result.promptAttachments).toMatchObject([{ text: "The confirmation button is disabled until the amount is accepted.", visualCount: 1 }]);
    expect(result.warnings).toContain("design.png has a visual that was reduced before sending it to the AI model.");
    expect(result.warnings).toContain("Some selected attachment visuals were omitted to preserve room for the workflow prompt in the model context window.");
  });
});

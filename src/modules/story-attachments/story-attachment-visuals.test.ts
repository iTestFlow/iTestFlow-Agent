import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { minimalTextPdf } from "@/test/fixtures/documents/builders";

import {
  extractStoryAttachmentVisuals,
  MAX_STORY_ATTACHMENT_VISUAL_DIMENSION,
  normalizeStoryAttachmentVisualForLlm,
} from "./story-attachment-visuals";

describe("story attachment visual extraction", () => {
  it("keeps a validated standalone screenshot in its original image format", async () => {
    const screenshot = await sharp({
      create: { width: 24, height: 12, channels: 3, background: "#336699" },
    }).png().toBuffer();

    const result = await extractStoryAttachmentVisuals({
      format: "png",
      mimeType: "image/png",
      data: screenshot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.visuals).toHaveLength(1);
    expect(result.visuals[0]).toMatchObject({
      source: "original",
      sourceLocator: "original",
      mimeType: "image/png",
      width: 24,
      height: 12,
      data: screenshot,
    });
  });

  it("keeps an oversized standalone upload intact while making a bounded LLM derivative", async () => {
    const screenshot = await sharp({
      create: { width: 2_400, height: 1_200, channels: 3, background: "#336699" },
    }).png().toBuffer();
    const originalCopy = Buffer.from(screenshot);

    const extraction = await extractStoryAttachmentVisuals({
      format: "png",
      mimeType: "image/png",
      data: screenshot,
    });

    expect(extraction.visuals).toHaveLength(1);
    expect(extraction.visuals[0]).toMatchObject({
      source: "original",
      mimeType: "image/png",
      data: originalCopy,
      width: 2_400,
      height: 1_200,
    });

    const derivative = await normalizeStoryAttachmentVisualForLlm(extraction.visuals[0]!);

    expect(screenshot).toEqual(originalCopy);
    expect(derivative).toMatchObject({ mimeType: "image/jpeg", normalized: true });
    expect(Math.max(derivative.width, derivative.height)).toBeLessThanOrEqual(MAX_STORY_ATTACHMENT_VISUAL_DIMENSION);
    await expect(sharp(derivative.data).metadata()).resolves.toMatchObject({ format: "jpeg" });
  });

  it("renders a PDF page into a bounded derived image", async () => {
    const result = await extractStoryAttachmentVisuals({
      format: "pdf",
      mimeType: "application/pdf",
      data: minimalTextPdf("Visual acceptance proof"),
    });

    expect(result.visuals).toHaveLength(1);
    expect(result.visuals[0]).toMatchObject({ source: "pdf_page", sourceLocator: "page-1", mimeType: "image/jpeg" });
    expect(result.visuals[0]?.byteSize).toBeGreaterThan(0);
    await expect(sharp(result.visuals[0]!.data).metadata()).resolves.toMatchObject({ format: "jpeg" });
  });
});

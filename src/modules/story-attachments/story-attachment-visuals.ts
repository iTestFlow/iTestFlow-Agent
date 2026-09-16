import mammoth from "mammoth";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, type PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

import { getImageMaxPixels, validateDocumentUpload } from "@/modules/documents/document-upload-validation";
import type { DocumentFormat } from "@/modules/documents/parsed-document.types";

export const MAX_STORY_ATTACHMENT_VISUALS = 12;
export const MAX_STORY_ATTACHMENT_VISUAL_BYTES = 12 * 1024 * 1024;
export const MAX_STORY_ATTACHMENT_VISUAL_DIMENSION = 1_600;

export type ExtractedStoryAttachmentVisual = {
  source: "original" | "pdf_page" | "docx_embedded";
  sourceLocator: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: Buffer;
  byteSize: number;
  width: number;
  height: number;
};

export type StoryAttachmentVisualExtraction = {
  visuals: ExtractedStoryAttachmentVisual[];
  warnings: string[];
};

export type StoryAttachmentVisualForLlm = Pick<
  ExtractedStoryAttachmentVisual,
  "data" | "mimeType" | "width" | "height"
> & {
  normalized: boolean;
};

/**
 * Derives visual evidence while preserving the uploaded standalone image. The
 * workflow context creates a bounded derivative only when it prepares an LLM
 * request, so attachment storage always retains the original upload.
 */
export async function extractStoryAttachmentVisuals(input: {
  format: DocumentFormat;
  mimeType: string;
  data: Uint8Array;
  signal?: AbortSignal;
}): Promise<StoryAttachmentVisualExtraction> {
  throwIfAborted(input.signal);
  switch (input.format) {
    case "png":
    case "jpeg":
    case "webp":
      return extractOriginalImage({
        format: input.format,
        mimeType: input.mimeType,
        data: input.data,
        signal: input.signal,
      });
    case "pdf":
      return extractPdfPages(input);
    case "docx":
      return extractDocxImages(input);
    default:
      return { visuals: [], warnings: [] };
  }
}

async function extractOriginalImage(input: {
  format: "png" | "jpeg" | "webp";
  mimeType: string;
  data: Uint8Array;
  signal?: AbortSignal;
}): Promise<StoryAttachmentVisualExtraction> {
  throwIfAborted(input.signal);
  const metadata = await sharp(input.data, { failOn: "warning", limitInputPixels: getImageMaxPixels() }).metadata();
  const width = positiveDimension(metadata.width);
  const height = positiveDimension(metadata.height);
  const mimeType = input.format === "png" ? "image/png" : input.format === "jpeg" ? "image/jpeg" : "image/webp";
  return {
    visuals: [{
      source: "original",
      sourceLocator: "original",
      mimeType,
      data: Buffer.from(input.data),
      byteSize: input.data.byteLength,
      width,
      height,
    }],
    warnings: [],
  };
}

/**
 * Keeps the attachment's original bytes in storage while providing a bounded,
 * JPEG derivative for model input when a standalone visual is too large. PDF
 * and DOCX visuals are already normalized during extraction; this is also safe
 * for them if a persisted legacy visual exceeds the same bound.
 */
export async function normalizeStoryAttachmentVisualForLlm(input: {
  mimeType: ExtractedStoryAttachmentVisual["mimeType"];
  data: Uint8Array;
  width: number;
  height: number;
}): Promise<StoryAttachmentVisualForLlm> {
  const width = positiveDimension(input.width);
  const height = positiveDimension(input.height);
  if (
    width <= MAX_STORY_ATTACHMENT_VISUAL_DIMENSION
    && height <= MAX_STORY_ATTACHMENT_VISUAL_DIMENSION
    && input.data.byteLength <= MAX_STORY_ATTACHMENT_VISUAL_BYTES
  ) {
    return {
      data: Buffer.from(input.data),
      mimeType: input.mimeType,
      width,
      height,
      normalized: false,
    };
  }

  const normalized = await normalizeDerivedVisual(input.data);
  return {
    ...normalized,
    mimeType: "image/jpeg",
    normalized: true,
  };
}

async function extractPdfPages(input: {
  format: DocumentFormat;
  mimeType: string;
  data: Uint8Array;
  signal?: AbortSignal;
}): Promise<StoryAttachmentVisualExtraction> {
  let loadingTask: PDFDocumentLoadingTask | undefined;
  const visuals: ExtractedStoryAttachmentVisual[] = [];
  const warnings: string[] = [];
  try {
    // A copy is required because PDF.js can transfer/detach its input buffer.
    loadingTask = getDocument({ data: new Uint8Array(input.data), stopAtErrors: false });
    const pdf = await loadingTask.promise;
    const pageLimit = Math.min(pdf.numPages, MAX_STORY_ATTACHMENT_VISUALS);
    if (pdf.numPages > pageLimit) warnings.push(`Only the first ${pageLimit} PDF pages were kept as visual evidence.`);
    let usedBytes = 0;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      throwIfAborted(input.signal);
      try {
        const page = await pdf.getPage(pageNumber);
        const naturalViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1.5, MAX_STORY_ATTACHMENT_VISUAL_DIMENSION / Math.max(naturalViewport.width, naturalViewport.height));
        const viewport = page.getViewport({ scale: Math.max(scale, 0.01) });
        const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
        const canvasContext = canvas.getContext("2d");
        const renderTask = page.render({
          // PDF.js accepts an explicit 2D context when rendering on the server.
          // There is no browser HTMLCanvasElement in this worker environment.
          canvas: null,
          canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
          viewport,
        });
        await renderTask.promise;
        throwIfAborted(input.signal);
        const normalized = await normalizeDerivedVisual(canvas.toBuffer("image/jpeg", 82));
        if (usedBytes + normalized.byteSize > MAX_STORY_ATTACHMENT_VISUAL_BYTES) {
          warnings.push("PDF rendering reached the visual-evidence byte limit.");
          break;
        }
        usedBytes += normalized.byteSize;
        visuals.push({
          source: "pdf_page",
          sourceLocator: `page-${pageNumber}`,
          mimeType: "image/jpeg",
          ...normalized,
        });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        warnings.push(`PDF page ${pageNumber} could not be rendered as an image.`);
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    warnings.push("PDF pages could not be rendered as visual evidence.");
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
  return { visuals, warnings };
}

async function extractDocxImages(input: {
  format: DocumentFormat;
  mimeType: string;
  data: Uint8Array;
  signal?: AbortSignal;
}): Promise<StoryAttachmentVisualExtraction> {
  const candidates: Array<{ mimeType: string; data: Buffer }> = [];
  const warnings: string[] = [];
  try {
    await mammoth.convertToHtml(
      { buffer: Buffer.from(input.data) },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          if (candidates.length >= MAX_STORY_ATTACHMENT_VISUALS) return { src: "" };
          candidates.push({ mimeType: image.contentType, data: await image.readAsBuffer() });
          return { src: "" };
        }),
      },
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { visuals: [], warnings: ["DOCX embedded images could not be extracted."] };
  }
  throwIfAborted(input.signal);
  const visuals: ExtractedStoryAttachmentVisual[] = [];
  let usedBytes = 0;
  for (const [index, candidate] of candidates.entries()) {
    throwIfAborted(input.signal);
    const extension = extensionForImageMime(candidate.mimeType);
    if (!extension) {
      warnings.push(`DOCX embedded image ${index + 1} uses an unsupported image format.`);
      continue;
    }
    try {
      await validateDocumentUpload({
        fileName: `embedded-${index + 1}.${extension}`,
        data: candidate.data,
        declaredMimeType: candidate.mimeType,
      });
      const normalized = await normalizeDerivedVisual(candidate.data);
      if (usedBytes + normalized.byteSize > MAX_STORY_ATTACHMENT_VISUAL_BYTES) {
        warnings.push("DOCX image extraction reached the visual-evidence byte limit.");
        break;
      }
      usedBytes += normalized.byteSize;
      visuals.push({
        source: "docx_embedded",
        sourceLocator: `embedded-image-${index + 1}`,
        mimeType: "image/jpeg",
        ...normalized,
      });
    } catch {
      warnings.push(`DOCX embedded image ${index + 1} could not be validated.`);
    }
  }
  return { visuals, warnings };
}

async function normalizeDerivedVisual(data: Uint8Array): Promise<Pick<ExtractedStoryAttachmentVisual, "data" | "byteSize" | "width" | "height">> {
  const output = await sharp(data, { failOn: "warning", limitInputPixels: getImageMaxPixels() })
    .rotate()
    .resize({
      width: MAX_STORY_ATTACHMENT_VISUAL_DIMENSION,
      height: MAX_STORY_ATTACHMENT_VISUAL_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    data: output.data,
    byteSize: output.data.byteLength,
    width: positiveDimension(output.info.width),
    height: positiveDimension(output.info.height),
  };
}

function extensionForImageMime(value: string): "png" | "jpg" | "webp" | undefined {
  switch (value.toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    default: return undefined;
  }
}

function positiveDimension(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Derived visual has invalid dimensions.");
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Attachment processing was cancelled.");
}

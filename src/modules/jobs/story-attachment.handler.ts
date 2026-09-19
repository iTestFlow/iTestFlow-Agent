import "server-only";

import { z } from "zod";

import { DOCUMENT_PARSE_RECIPE_VERSION, parseDocument } from "@/modules/documents/document-parser-registry";
import { isDocumentParseError } from "@/modules/documents/parsed-document.types";
import {
  beginStoryAttachmentParse,
  completeStoryAttachmentParse,
  completeStoryAttachmentStorageCleanup,
  failStoryAttachmentParse,
  getStoryAttachmentCleanupTarget,
  getStoryAttachmentStorage,
  type PersistStoryAttachmentVisual,
} from "@/modules/story-attachments/story-attachments.service";
import { extractStoryAttachmentVisuals } from "@/modules/story-attachments/story-attachment-visuals";

import type { JobHandler } from "./job-handlers";

const ParsePayloadSchema = z.object({
  attachmentId: z.string().min(1),
  parseGeneration: z.number().int().positive(),
});
const CleanupPayloadSchema = z.object({ attachmentId: z.string().min(1) });

export const runStoryAttachmentParseJob: JobHandler = async (job, context) => {
  const payload = ParsePayloadSchema.parse(job.payload);
  const attachment = await beginStoryAttachmentParse(payload);
  if (!attachment) return { outcome: "skipped_stale_or_deleted", attachmentId: payload.attachmentId };

  try {
    context.signal.throwIfAborted();
    // The service removes matching stale DB rows under the attachment lock.
    // Remove only older object generations here; the new generation has not
    // written any files yet, so a duplicate worker cannot delete its own work.
    await getStoryAttachmentStorage().deleteVisualGenerationsBefore(attachment.id, attachment.parseGeneration);
    context.signal.throwIfAborted();
    await context.updateProgress({ phase: "reading_attachment", percent: 10, attachmentId: attachment.id });
    const data = await getStoryAttachmentStorage().read(attachment.storageKey);
    context.signal.throwIfAborted();

    await context.updateProgress({ phase: "parsing_document", percent: 35, attachmentId: attachment.id });
    const parsed = await parseDocument({
      format: attachment.fileFormat,
      data,
      fileName: attachment.originalFileName,
      signal: context.signal,
    });
    context.signal.throwIfAborted();

    await context.updateProgress({ phase: "extracting_visuals", percent: 60, attachmentId: attachment.id });
    const extracted = await extractStoryAttachmentVisuals({
      format: attachment.fileFormat,
      mimeType: attachment.mimeType,
      data,
      signal: context.signal,
    });
    const visuals = await persistVisualObjects({
      attachmentId: attachment.id,
      parseGeneration: attachment.parseGeneration,
      originalStorageKey: attachment.storageKey,
      visuals: extracted.visuals,
    });
    context.signal.throwIfAborted();

    const warnings = [...parsed.warnings.map((warning) => warning.message), ...extracted.warnings];
    const status = parsed.status === "partially_parsed" || warnings.length > 0 ? "partially_parsed" : "parsed";
    await context.updateProgress({ phase: "saving_result", percent: 85, attachmentId: attachment.id });
    const saved = await completeStoryAttachmentParse({
      attachmentId: attachment.id,
      parseGeneration: attachment.parseGeneration,
      status,
      parsedText: parsedText(parsed.sections),
      sections: parsed.sections,
      warnings,
      metadata: {
        ...parsed.documentMetadata,
        visualCount: visuals.length,
        visualByteSize: visuals.reduce((total, visual) => total + visual.byteSize, 0),
      },
      recipeVersion: DOCUMENT_PARSE_RECIPE_VERSION,
      visuals,
    });
    if (!saved) {
      // A delete/retry won the generation race after a derived object write.
      // Delete only this generation: a retry retains the immutable original.
      await getStoryAttachmentStorage().deleteVisualGeneration(attachment.id, attachment.parseGeneration);
      return { outcome: "skipped_stale_or_deleted", attachmentId: attachment.id };
    }
    await context.updateProgress({ phase: "complete", percent: 100, attachmentId: attachment.id, visualCount: visuals.length });
    return { outcome: status, attachmentId: attachment.id, visualCount: visuals.length, warningCount: warnings.length };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const errorMessage = isDocumentParseError(error)
      ? error.message
      : "Attachment processing could not be completed. Please retry the attachment.";
    await failStoryAttachmentParse({
      attachmentId: attachment.id,
      parseGeneration: attachment.parseGeneration,
      errorMessage,
    });
    if (isDocumentParseError(error)) {
      return { outcome: "parse_failed", attachmentId: attachment.id };
    }
    throw error;
  }
};

export const runStoryAttachmentCleanupJob: JobHandler = async (job) => {
  const payload = CleanupPayloadSchema.parse(job.payload);
  const target = await getStoryAttachmentCleanupTarget(payload);
  if (!target) return { outcome: "skipped_not_pending", attachmentId: payload.attachmentId };
  await getStoryAttachmentStorage().deleteAttachmentTree(target.attachmentId);
  await completeStoryAttachmentStorageCleanup(target);
  return { outcome: "cleaned", attachmentId: target.attachmentId };
};

async function persistVisualObjects(input: {
  attachmentId: string;
  parseGeneration: number;
  originalStorageKey: string;
  visuals: Awaited<ReturnType<typeof extractStoryAttachmentVisuals>>["visuals"];
}): Promise<PersistStoryAttachmentVisual[]> {
  const storage = getStoryAttachmentStorage();
  const persisted: PersistStoryAttachmentVisual[] = [];
  for (const [ordinal, visual] of input.visuals.entries()) {
    const stored = visual.source === "original"
      ? { storageKey: input.originalStorageKey, byteSize: visual.byteSize }
      : await storage.putVisual({
          attachmentId: input.attachmentId,
          parseGeneration: input.parseGeneration,
          ordinal,
          mimeType: visual.mimeType,
          data: visual.data,
        });
    persisted.push({
      ordinal,
      source: visual.source,
      sourceLocator: visual.sourceLocator,
      mimeType: visual.mimeType,
      byteSize: stored.byteSize,
      width: visual.width,
      height: visual.height,
      storageKey: stored.storageKey,
    });
  }
  return persisted;
}

function parsedText(sections: Array<{ sectionKey: string; text: string }>): string {
  return sections.map((section) => `[${section.sectionKey}]\n${section.text}`).join("\n\n");
}

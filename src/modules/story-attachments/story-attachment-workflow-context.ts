import "server-only";

import {
  MAX_LLM_IMAGE_INPUT_BASE64_BYTES,
  MAX_LLM_IMAGE_INPUT_COUNT,
  MAX_LLM_IMAGE_INPUT_TOTAL_BASE64_BYTES,
  type LLMImageInput,
} from "@/modules/llm/llm-types";
import type { StoryAttachmentPromptContext } from "@/modules/llm/markdown-prompt-renderer";
import { FALLBACK_MAX_INPUT_TOKENS } from "@/modules/llm/token-estimate";

import {
  StoryAttachmentValidationError,
  readStoryAttachmentForAi,
  type StoryAttachmentAiContext,
  type StoryAttachmentScope,
} from "./story-attachments.service";
import {
  MAX_STORY_ATTACHMENT_VISUAL_DIMENSION,
  normalizeStoryAttachmentVisualForLlm,
} from "./story-attachment-visuals";

/** Keep image inputs below half of the configured model window. */
export const STORY_ATTACHMENT_IMAGE_INPUT_WINDOW_SHARE = 0.5;
const STORY_ATTACHMENT_IMAGE_TILE_SIZE = 512;
const STORY_ATTACHMENT_IMAGE_TOKENS_PER_TILE = 256;

export type StoryAttachmentWorkflowContext = {
  promptAttachments: StoryAttachmentPromptContext[];
  citationAttachments: Array<{ id: string; fileName: string; mimeType?: string; visualCount: number }>;
  images: LLMImageInput[];
  /** Conservative reserve for the selected native image parts. */
  imageTokenReserve: number;
  /** Pass this to text prompt builders so text plus native images fit one model window. */
  effectivePromptInputTokens: number;
  warnings: string[];
};

/**
 * Resolves only selected, already parsed story-local attachments. Image bytes are
 * made available solely to automatic provider requests; copied/manual prompts carry
 * extracted text and provenance but never serialized binary data.
 */
export async function loadSelectedStoryAttachmentWorkflowContext(input: {
  scope: StoryAttachmentScope;
  attachmentIds: string[];
  includeVisuals: boolean;
  /** Configured model input window. Falls back to the shared conservative default. */
  maxInputTokens?: number;
}): Promise<StoryAttachmentWorkflowContext> {
  const attachmentIds = uniqueAttachmentIds(input.attachmentIds);
  const contexts: StoryAttachmentAiContext[] = [];
  for (const attachmentId of attachmentIds) {
    const context = await readStoryAttachmentForAi({ scope: input.scope, attachmentId });
    if (!context) throw new StoryAttachmentValidationError("A selected attachment was not found on this story.");
    contexts.push(context);
  }

  const visualCounts = new Map<string, number>(contexts.map((context) => [context.attachment.id, 0]));
  const images: LLMImageInput[] = [];
  const warnings: string[] = [];
  const inputWindowTokens = resolveInputWindowTokens(input.maxInputTokens);
  const imageTokenBudget = Math.floor(inputWindowTokens * STORY_ATTACHMENT_IMAGE_INPUT_WINDOW_SHARE);
  let imageTokenReserve = 0;
  let totalBase64Bytes = 0;
  let omittedVisualForModelContext = false;

  if (!input.includeVisuals && contexts.some((context) => context.visuals.length > 0)) {
    warnings.push("Visual attachment content is not embedded in copied prompts. To have an external LLM inspect it, upload the selected files to that external LLM as well.");
  }

  if (input.includeVisuals) {
    for (const context of contexts) {
      for (const visual of context.visuals) {
        if (images.length >= MAX_LLM_IMAGE_INPUT_COUNT) {
          warnings.push("Only the first 20 selected attachment visuals were included in this AI request.");
          omittedVisualForModelContext = true;
          break;
        }
        const visualTokenReserve = estimateStoryAttachmentVisualTokens(visual.width, visual.height);
        if (imageTokenReserve + visualTokenReserve > imageTokenBudget) {
          omittedVisualForModelContext = true;
          continue;
        }

        let preparedVisual;
        try {
          preparedVisual = await normalizeStoryAttachmentVisualForLlm(visual);
        } catch {
          warnings.push(`${context.attachment.originalFileName} has a visual that could not be prepared for the AI request.`);
          omittedVisualForModelContext = true;
          continue;
        }
        const data = preparedVisual.data.toString("base64");
        if (data.length > MAX_LLM_IMAGE_INPUT_BASE64_BYTES) {
          warnings.push(`${context.attachment.originalFileName} has a visual that is too large for the selected AI provider.`);
          omittedVisualForModelContext = true;
          continue;
        }
        if (totalBase64Bytes + data.length > MAX_LLM_IMAGE_INPUT_TOTAL_BASE64_BYTES) {
          warnings.push("Some attachment visuals were omitted to stay within the AI request image limit.");
          omittedVisualForModelContext = true;
          break;
        }
        images.push({ mediaType: preparedVisual.mimeType, data });
        imageTokenReserve += visualTokenReserve;
        totalBase64Bytes += data.length;
        visualCounts.set(context.attachment.id, (visualCounts.get(context.attachment.id) ?? 0) + 1);
      }
      if (images.length >= MAX_LLM_IMAGE_INPUT_COUNT || totalBase64Bytes >= MAX_LLM_IMAGE_INPUT_TOTAL_BASE64_BYTES) break;
    }
  }

  if (omittedVisualForModelContext) {
    warnings.push("Some selected attachment visuals were omitted to preserve room for the workflow prompt in the model context window.");
  }

  return {
    promptAttachments: contexts.map((context) => ({
      id: context.attachment.id,
      fileName: context.attachment.originalFileName,
      mimeType: context.attachment.mimeType,
      text: context.text,
      visualCount: visualCounts.get(context.attachment.id) ?? 0,
    })),
    citationAttachments: contexts.map((context) => ({
      id: context.attachment.id,
      fileName: context.attachment.originalFileName,
      mimeType: context.attachment.mimeType,
      visualCount: visualCounts.get(context.attachment.id) ?? 0,
    })),
    images,
    imageTokenReserve,
    effectivePromptInputTokens: inputWindowTokens - imageTokenReserve,
    warnings: Array.from(new Set(warnings)),
  };
}

function resolveInputWindowTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : FALLBACK_MAX_INPUT_TOKENS;
}

/**
 * Reserve by persisted dimensions, capped to the visual derivative size. A 512px
 * tile costs 256 tokens, which is deliberately higher than documented Gemini
 * tiles and keeps enough headroom for providers with different vision pricing.
 */
function estimateStoryAttachmentVisualTokens(width: number, height: number): number {
  const bounded = dimensionsWithinVisualBound(width, height);
  return Math.max(
    STORY_ATTACHMENT_IMAGE_TOKENS_PER_TILE,
    Math.ceil(bounded.width / STORY_ATTACHMENT_IMAGE_TILE_SIZE)
      * Math.ceil(bounded.height / STORY_ATTACHMENT_IMAGE_TILE_SIZE)
      * STORY_ATTACHMENT_IMAGE_TOKENS_PER_TILE,
  );
}

function dimensionsWithinVisualBound(width: number, height: number): { width: number; height: number } {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : 1;
  const scale = Math.min(1, MAX_STORY_ATTACHMENT_VISUAL_DIMENSION / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.ceil(safeWidth * scale)),
    height: Math.max(1, Math.ceil(safeHeight * scale)),
  };
}

function uniqueAttachmentIds(value: string[]) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate.trim()) throw new StoryAttachmentValidationError("Attachment IDs must be non-empty text values.");
    const id = candidate.trim();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length > MAX_LLM_IMAGE_INPUT_COUNT) {
    throw new StoryAttachmentValidationError(`Select at most ${MAX_LLM_IMAGE_INPUT_COUNT} attachments for one AI request.`);
  }
  return ids;
}

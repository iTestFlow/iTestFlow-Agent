import { z } from "zod";

export const ContextSuggestionItemSchema = z.object({
  workItemId: z.string(),
  title: z.string(),
  workItemType: z.string(),
  relationshipType: z.string().optional(),
  relevanceScore: z.number().min(0).max(1),
  reason: z.string(),
});

/**
 * A source-aware suggestion for an immutable uploaded-document version.  The
 * route re-hydrates these IDs from the retrieved candidate set before returning
 * them, so a model cannot manufacture a document or a locator that was not in
 * the project context it received.
 */
export const ContextSuggestionDocumentSchema = z.object({
  documentId: z.string().min(1),
  documentVersionId: z.string().min(1),
  documentName: z.string().min(1),
  relevanceScore: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const ContextSuggestionOutputSchema = z.object({
  // The existing work-item array remains required. The new sibling document
  // array defaults empty so older provider outputs remain valid during rollout.
  suggestedItems: z.array(ContextSuggestionItemSchema),
  suggestedDocuments: z.array(ContextSuggestionDocumentSchema).default([]),
});

export type ContextSuggestionItem = z.infer<typeof ContextSuggestionItemSchema>;
export type ContextSuggestionDocument = z.infer<typeof ContextSuggestionDocumentSchema>;

import { z } from "zod";

export const ContextSuggestionItemSchema = z.object({
  workItemId: z.string(),
  title: z.string(),
  workItemType: z.string(),
  relationshipType: z.string().optional(),
  relevanceScore: z.number().min(0).max(1),
  reason: z.string(),
});

export const ContextSuggestionOutputSchema = z.object({
  suggestedItems: z.array(ContextSuggestionItemSchema),
});

export type ContextSuggestionItem = z.infer<typeof ContextSuggestionItemSchema>;

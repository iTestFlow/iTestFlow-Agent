import { z } from "zod";

import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { ContextUsedItem } from "@/modules/rag/auto-context-resolver.service";

export const WorkflowContextCitationSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("project_context"),
    sourceId: z.string().min(1),
    title: z.string().min(1),
    workItemId: z.string().min(1),
    workItemType: z.string().min(1),
  }),
  z.object({
    sourceType: z.literal("project_knowledge"),
    sourceId: z.string().min(1),
    title: z.string().min(1),
    category: z.string().min(1),
    sourceWorkItemIds: z.array(z.string()).default([]),
  }),
]);

export const WorkflowContextCitationsSchema = z.array(WorkflowContextCitationSchema).default([]);

export type WorkflowContextCitation = z.infer<typeof WorkflowContextCitationSchema>;

export function buildWorkflowContextCitations(input: {
  resolvedContextUsed: ContextUsedItem[];
  relevantProjectKnowledgeBase?: ProjectKnowledgeBase | null;
}): WorkflowContextCitation[] {
  const citations: WorkflowContextCitation[] = input.resolvedContextUsed.map((item) => ({
    sourceType: "project_context",
    sourceId: `WI:${item.workItemId}`,
    title: item.title,
    workItemId: item.workItemId,
    workItemType: item.workItemType,
  }));
  const knowledgeBase = input.relevantProjectKnowledgeBase;

  if (knowledgeBase) {
    citations.push(
      ...knowledgeBase.modules.map((item) =>
        toKnowledgeCitation("module", item.id, item.name, item.sourceWorkItemIds),
      ),
      ...knowledgeBase.businessRules.map((item) =>
        toKnowledgeCitation("business_rule", item.id, item.rule, item.sourceWorkItemIds),
      ),
      ...knowledgeBase.stateTransitions.map((item) =>
        toKnowledgeCitation(
          "state_transition",
          item.id,
          [item.workflowName, [item.fromState, item.toState].filter(Boolean).join(" -> ")]
            .filter(Boolean)
            .join(": "),
          item.sourceWorkItemIds,
        ),
      ),
      ...knowledgeBase.glossary.map((item) =>
        toKnowledgeCitation("glossary", item.term, item.term, item.sourceWorkItemIds),
      ),
      ...knowledgeBase.crossDependencies.map((item) =>
        toKnowledgeCitation(
          "dependency",
          item.id,
          `${item.sourceModule} -> ${item.targetModule}`,
          item.sourceWorkItemIds,
        ),
      ),
    );
  }

  const unique = new Map<string, WorkflowContextCitation>();
  citations.forEach((citation) => {
    if (!unique.has(citation.sourceId)) unique.set(citation.sourceId, citation);
  });
  return Array.from(unique.values());
}

function toKnowledgeCitation(
  category: string,
  entryKey: string,
  title: string,
  sourceWorkItemIds: string[],
): WorkflowContextCitation {
  return {
    sourceType: "project_knowledge",
    sourceId: `KB:${category}:${entryKey}`,
    title,
    category,
    sourceWorkItemIds,
  };
}

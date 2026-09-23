import { z } from "zod";

import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { ContextUsedItem } from "@/modules/rag/auto-context-resolver.service";
import {
  sourceIdForProjectKnowledge,
  sourceIdForStoryAttachment,
  sourceIdForWorkItem,
} from "./workflow-context-controls";

export const WORKFLOW_CONTEXT_REASON_MAX_LENGTH = 160;

const WorkflowContextCitationReasonSchema = z.string().trim().min(1).max(WORKFLOW_CONTEXT_REASON_MAX_LENGTH).optional();

export const WorkflowContextCitationSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("project_context"),
    sourceId: z.string().min(1),
    title: z.string().min(1),
    reason: WorkflowContextCitationReasonSchema,
    workItemId: z.string().min(1),
    workItemType: z.string().min(1),
  }),
  z.object({
    sourceType: z.literal("project_knowledge"),
    sourceId: z.string().min(1),
    title: z.string().min(1),
    reason: WorkflowContextCitationReasonSchema,
    category: z.string().min(1),
    sourceWorkItemIds: z.array(z.string()).default([]),
  }),
  z.object({
    sourceType: z.literal("uploaded_document"),
    sourceId: z.string().min(1),
    title: z.string().min(1),
    reason: WorkflowContextCitationReasonSchema,
    documentId: z.string().min(1),
    documentVersionId: z.string().min(1).optional(),
    documentName: z.string().min(1),
    section: z.string().min(1).optional(),
    pageNumber: z.number().int().positive().optional(),
  }),
  z.object({
    sourceType: z.literal("story_attachment"),
    sourceId: z.string().min(1),
    title: z.string().min(1),
    reason: WorkflowContextCitationReasonSchema,
    attachmentId: z.string().min(1),
    fileName: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    visualCount: z.number().int().nonnegative().optional(),
  }),
]);

export const WorkflowContextCitationsSchema = z.array(WorkflowContextCitationSchema).default([]);

export type WorkflowContextCitation = z.infer<typeof WorkflowContextCitationSchema>;

/** Return a compact display sentence while keeping legacy citation payloads valid. */
export function normalizeWorkflowContextReason(value: string | null | undefined, fallback: string) {
  const compact = (value?.trim() || fallback).replace(/\s+/g, " ").trim();
  const firstSentence = compact.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? compact;
  const stem = firstSentence.replace(/[.!?]+$/u, "").trim();
  const truncated = Array.from(stem).slice(0, WORKFLOW_CONTEXT_REASON_MAX_LENGTH - 1).join("").trimEnd();
  return `${truncated || "Relevant context"}.`;
}

export function buildWorkflowContextCitations(input: {
  resolvedContextUsed: ContextUsedItem[];
  targetWorkItemId?: string;
  relevantProjectKnowledgeBase?: ProjectKnowledgeBase | null;
  storyAttachments?: Array<{
    id: string;
    fileName: string;
    mimeType?: string;
    visualCount?: number;
  }>;
}): WorkflowContextCitation[] {
  const citations: WorkflowContextCitation[] = input.resolvedContextUsed.map((item) => ({
    sourceType: "project_context",
    sourceId: sourceIdForWorkItem(item.workItemId),
    title: item.title,
    reason: workItemCitationReason(item),
    workItemId: item.workItemId,
    workItemType: item.workItemType,
  }));
  const knowledgeBase = input.relevantProjectKnowledgeBase;

  if (knowledgeBase) {
    const reasonContext = {
      targetWorkItemId: input.targetWorkItemId,
      contextByWorkItemId: new Map(input.resolvedContextUsed.map((item) => [item.workItemId, item.title])),
    };
    citations.push(
      ...knowledgeBase.modules.map((item) =>
        toKnowledgeCitation("module", item.id, item.name, item.sourceWorkItemIds, item.description, reasonContext),
      ),
      ...knowledgeBase.businessRules.map((item) =>
        toKnowledgeCitation("business_rule", item.id, item.rule, item.sourceWorkItemIds,
          item.moduleName ? `Applies to ${item.moduleName} behavior` : `Checks a constraint from ${readableSourceField(item.sourceField)}`, reasonContext),
      ),
      ...knowledgeBase.stateTransitions.map((item) =>
        toKnowledgeCitation(
          "state_transition",
          item.id,
          [item.workflowName, [item.fromState, item.toState].filter(Boolean).join(" -> ")]
            .filter(Boolean)
            .join(": "),
          item.sourceWorkItemIds,
          `Triggered when ${item.triggerOrCondition}`,
          reasonContext,
        ),
      ),
      ...knowledgeBase.glossary.map((item) =>
        toKnowledgeCitation("glossary", item.term, item.term, item.sourceWorkItemIds, item.definition, reasonContext),
      ),
      ...knowledgeBase.crossDependencies.map((item) =>
        toKnowledgeCitation(
          "dependency",
          item.id,
          `${item.sourceModule} -> ${item.targetModule}`,
          item.sourceWorkItemIds,
          item.description,
          reasonContext,
        ),
      ),
      ...knowledgeBase.chatInsights.map((item) =>
        toKnowledgeCitation("chat_insight", item.id, item.title, item.sourceWorkItemIds, item.content, reasonContext),
      ),
    );
  }

  for (const attachment of input.storyAttachments ?? []) {
    const attachmentId = attachment.id.trim();
    const fileName = attachment.fileName.trim();
    if (!attachmentId || !fileName) continue;
    citations.push({
      sourceType: "story_attachment",
      sourceId: sourceIdForStoryAttachment(attachmentId),
      title: fileName,
      reason: normalizeWorkflowContextReason(undefined, "Attached to this story."),
      attachmentId,
      fileName,
      mimeType: attachment.mimeType?.trim() || undefined,
      visualCount: Number.isInteger(attachment.visualCount) && attachment.visualCount! >= 0
        ? attachment.visualCount
        : undefined,
    });
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
  detail: string,
  context: { targetWorkItemId?: string; contextByWorkItemId: Map<string, string> },
): WorkflowContextCitation {
  return {
    sourceType: "project_knowledge",
    sourceId: sourceIdForProjectKnowledge(category, entryKey),
    title,
    reason: projectKnowledgeCitationReason(category, title, detail, sourceWorkItemIds, context),
    category,
    sourceWorkItemIds,
  };
}

function workItemCitationReason(item: ContextUsedItem) {
  const fallback = {
    explicit: "Selected for this story.",
    linked_requirement: "Linked to this story.",
    stored_project_context: "Similar to this story's content.",
    llm_selected_context: "Selected as relevant to this story.",
  }[item.source];
  return normalizeWorkflowContextReason(item.reason, fallback);
}

function projectKnowledgeCitationReason(
  category: string,
  title: string,
  detail: string,
  sourceWorkItemIds: string[],
  context: { targetWorkItemId?: string; contextByWorkItemId: Map<string, string> },
) {
  const sourceIds = sourceWorkItemIds.map((id) => id.trim());
  const relatedTitle = sourceIds.map((id) => context.contextByWorkItemId.get(id)).find(Boolean);
  const prefix = context.targetWorkItemId && sourceIds.includes(context.targetWorkItemId)
    ? "From this story"
    : relatedTitle
      ? `From retrieved “${relatedTitle}”`
      : {
          module: "Module behavior",
          business_rule: "Business rule",
          state_transition: "Workflow behavior",
          glossary: "Project term",
          dependency: "Module dependency",
          chat_insight: "Approved project insight",
        }[category] ?? "Project knowledge";
  const content = detail.trim() && detail.trim().toLowerCase() !== title.trim().toLowerCase()
    ? detail.trim()
    : `${title} context`;
  return normalizeWorkflowContextReason(`${prefix}: ${content}`, "Relevant project knowledge.");
}

function readableSourceField(sourceField: string) {
  return sourceField === "acceptanceCriteria" ? "acceptance criteria" : sourceField.trim() || "the source story";
}

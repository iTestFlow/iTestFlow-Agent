import { z } from "zod";

import type { ProjectKnowledgeBase } from "./project-knowledge.schema";

const WorkflowContextSourceIdSchema = z.string().trim().min(1);

/**
 * Optional review controls travel with a single workflow request.  Leaving
 * reviewedSourceIds undefined keeps automatic retrieval; an explicit empty
 * array means the reviewer chose no optional context.
 */
export const WorkflowContextControlsSchema = z.object({
  reviewedSourceIds: z.array(WorkflowContextSourceIdSchema).optional(),
  excludedSourceIds: z.array(WorkflowContextSourceIdSchema).optional().default([]),
});

export type WorkflowContextControls = z.infer<typeof WorkflowContextControlsSchema>;
export type WorkflowContextControlsInput = z.input<typeof WorkflowContextControlsSchema>;

export type WorkflowContextSourceIdentity =
  | { sourceType: "work_item"; workItemId: string }
  | { sourceType: "project_knowledge"; category: string; entryKey: string }
  | { sourceType: "story_attachment"; attachmentId: string };

export function normalizeWorkflowContextControls(
  input?: WorkflowContextControlsInput | WorkflowContextControls,
): WorkflowContextControls {
  const parsed = WorkflowContextControlsSchema.parse(input ?? {});
  return {
    ...(parsed.reviewedSourceIds === undefined
      ? {}
      : { reviewedSourceIds: distinctSourceIds(parsed.reviewedSourceIds) }),
    excludedSourceIds: distinctSourceIds(parsed.excludedSourceIds),
  };
}

export function sourceIdForWorkItem(workItemId: string) {
  return `WI:${workItemId.trim()}`;
}

export function sourceIdForProjectKnowledge(category: string, entryKey: string) {
  return `KB:${category.trim()}:${entryKey.trim()}`;
}

export function sourceIdForStoryAttachment(attachmentId: string) {
  return `SA:${attachmentId.trim()}`;
}

/**
 * Source IDs are intentionally parsed by their known prefix.  Knowledge keys
 * may contain colons, so splitting every colon would corrupt their identity.
 */
export function parseWorkflowContextSourceId(sourceId: string): WorkflowContextSourceIdentity | null {
  const value = sourceId.trim();
  if (value.startsWith("WI:")) {
    const workItemId = value.slice("WI:".length).trim();
    return workItemId ? { sourceType: "work_item", workItemId } : null;
  }
  if (value.startsWith("SA:")) {
    const attachmentId = value.slice("SA:".length).trim();
    return attachmentId ? { sourceType: "story_attachment", attachmentId } : null;
  }
  if (!value.startsWith("KB:")) return null;

  const key = value.slice("KB:".length);
  const separator = key.indexOf(":");
  if (separator < 1 || separator === key.length - 1) return null;
  const category = key.slice(0, separator).trim();
  const entryKey = key.slice(separator + 1).trim();
  return category && entryKey ? { sourceType: "project_knowledge", category, entryKey } : null;
}

export function workItemIdFromSourceId(sourceId: string) {
  const source = parseWorkflowContextSourceId(sourceId);
  return source?.sourceType === "work_item" ? source.workItemId : null;
}

export function projectKnowledgeSourceFromSourceId(sourceId: string) {
  const source = parseWorkflowContextSourceId(sourceId);
  return source?.sourceType === "project_knowledge" ? source : null;
}

export function storyAttachmentIdFromSourceId(sourceId: string) {
  const source = parseWorkflowContextSourceId(sourceId);
  return source?.sourceType === "story_attachment" ? source.attachmentId : null;
}

export function workItemIdsFromSourceIds(sourceIds: readonly string[]) {
  return sourceIds
    .map(workItemIdFromSourceId)
    .filter((workItemId): workItemId is string => Boolean(workItemId));
}

export function isWorkflowContextSourceAllowed(
  sourceId: string,
  controlsInput?: WorkflowContextControlsInput | WorkflowContextControls,
) {
  const controls = normalizeWorkflowContextControls(controlsInput);
  return isSourceAllowed(sourceId, controls);
}

export function filterWorkItemSourcesForContextControls<TSource extends { workItemId: string }>(
  sources: readonly TSource[],
  controlsInput?: WorkflowContextControlsInput | WorkflowContextControls,
) {
  const controls = normalizeWorkflowContextControls(controlsInput);
  return sources.filter((source) => isSourceAllowed(sourceIdForWorkItem(source.workItemId), controls));
}

/**
 * Apply an explicit KB allowlist first, then suppress any entry derived from
 * an excluded work item.  A mixed-source entry is omitted if any source is
 * excluded, because it can still expose the removed source's information.
 */
export function filterProjectKnowledgeForContextControls(
  knowledgeBase: ProjectKnowledgeBase | null | undefined,
  controlsInput?: WorkflowContextControlsInput | WorkflowContextControls,
): ProjectKnowledgeBase | null | undefined {
  if (!knowledgeBase) return knowledgeBase;
  const controls = normalizeWorkflowContextControls(controlsInput);
  if (controls.reviewedSourceIds === undefined && !controls.excludedSourceIds.length) return knowledgeBase;

  const filterEntries = <TEntry extends { sourceWorkItemIds: string[] }>(
    category: string,
    entries: TEntry[],
    entryKey: (entry: TEntry) => string,
  ) => entries.filter((entry) => {
    if (!isSourceAllowed(sourceIdForProjectKnowledge(category, entryKey(entry)), controls)) return false;
    return !entry.sourceWorkItemIds.some((workItemId) =>
      controls.excludedSourceIds.includes(sourceIdForWorkItem(workItemId)),
    );
  });

  return {
    ...knowledgeBase,
    modules: filterEntries("module", knowledgeBase.modules, (entry) => entry.id),
    businessRules: filterEntries("business_rule", knowledgeBase.businessRules, (entry) => entry.id),
    stateTransitions: filterEntries("state_transition", knowledgeBase.stateTransitions, (entry) => entry.id),
    glossary: filterEntries("glossary", knowledgeBase.glossary, (entry) => entry.term),
    crossDependencies: filterEntries("dependency", knowledgeBase.crossDependencies, (entry) => entry.id),
    chatInsights: filterEntries("chat_insight", knowledgeBase.chatInsights, (entry) => entry.id),
  };
}

function distinctSourceIds(sourceIds: string[]) {
  return Array.from(new Set(sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean)));
}

function isSourceAllowed(sourceId: string, controls: WorkflowContextControls) {
  const normalizedSourceId = sourceId.trim();
  if (controls.excludedSourceIds.includes(normalizedSourceId)) return false;
  return controls.reviewedSourceIds === undefined || controls.reviewedSourceIds.includes(normalizedSourceId);
}

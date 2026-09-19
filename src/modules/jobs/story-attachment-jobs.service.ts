import "server-only";

import type { PoolClient } from "pg";

import { enqueueJob } from "./job-queue.service";

export const STORY_ATTACHMENT_PARSE = "story_attachment_parse";
export const STORY_ATTACHMENT_CLEANUP = "story_attachment_cleanup";

export async function enqueueStoryAttachmentParseJob(input: {
  workspaceId: string;
  projectId: string;
  attachmentId: string;
  parseGeneration: number;
  actor: string;
}, client?: PoolClient): Promise<string | null> {
  return enqueueJob({
    jobType: STORY_ATTACHMENT_PARSE,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    payload: { attachmentId: input.attachmentId, parseGeneration: input.parseGeneration },
    progress: { phase: "queued", percent: 0, attachmentId: input.attachmentId },
    dedupeKey: `${STORY_ATTACHMENT_PARSE}:${input.attachmentId}:${input.parseGeneration}`,
    createdByUserId: input.actor,
    maxAttempts: 3,
  }, client);
}

export async function enqueueStoryAttachmentCleanupJob(input: {
  workspaceId: string;
  projectId: string;
  attachmentId: string;
  actor: string;
}, client?: PoolClient): Promise<string | null> {
  return enqueueJob({
    jobType: STORY_ATTACHMENT_CLEANUP,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    payload: { attachmentId: input.attachmentId },
    progress: { phase: "queued", percent: 0, attachmentId: input.attachmentId },
    dedupeKey: `${STORY_ATTACHMENT_CLEANUP}:${input.attachmentId}`,
    createdByUserId: input.actor,
    maxAttempts: 5,
  }, client);
}

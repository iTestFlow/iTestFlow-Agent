import "server-only";

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { PoolClient } from "pg";

import {
  canonicalDocumentMimeType,
  getDocumentMaxUploadBytes,
  validateDocumentUpload,
} from "@/modules/documents/document-upload-validation";
import type { DocumentFormat } from "@/modules/documents/parsed-document.types";
import {
  enqueueStoryAttachmentCleanupJob,
  enqueueStoryAttachmentParseJob,
  STORY_ATTACHMENT_PARSE,
} from "@/modules/jobs/story-attachment-jobs.service";
import {
  createId,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";

import {
  createStoryAttachmentStorage,
  type StoryAttachmentStorage,
} from "./story-attachment-storage";

export const STORY_ATTACHMENT_PROVIDERS = ["azure-devops", "jira-cloud"] as const;
export type StoryAttachmentProviderId = (typeof STORY_ATTACHMENT_PROVIDERS)[number];

export const STORY_ATTACHMENT_SOURCE_KINDS = ["upload", "azure_devops_attachment", "jira_attachment"] as const;
export type StoryAttachmentSourceKind = (typeof STORY_ATTACHMENT_SOURCE_KINDS)[number];

export const STORY_ATTACHMENT_PARSE_STATUSES = ["pending", "parsing", "parsed", "partially_parsed", "parse_failed"] as const;
export type StoryAttachmentParseStatus = (typeof STORY_ATTACHMENT_PARSE_STATUSES)[number];

export type StoryAttachmentScope = {
  workspaceId: string;
  projectId: string;
  providerId: StoryAttachmentProviderId;
  /** Stable Azure work-item ID or Jira issue ID; never a mutable issue key. */
  canonicalStoryId: string;
  /** Current Azure ID/Jira key for display only. */
  storyDisplayKey: string;
};

export type StoryAttachmentByteSource = Uint8Array | Readable | AsyncIterable<Uint8Array>;

export type StoryAttachmentSource = {
  kind: StoryAttachmentSourceKind;
  /** Provider attachment ID for an imported Azure/Jira attachment. */
  externalAttachmentId?: string | null;
  /** Trusted provider metadata only; arbitrary client URLs must not be stored here. */
  metadata?: Record<string, unknown>;
};

export type StoryAttachmentParsedSection = {
  sectionKey: string;
  kind: string;
  text: string;
  pageNumber?: number;
  metadata?: Record<string, unknown>;
};

export type StoryAttachmentVisual = {
  id: string;
  source: "original" | "pdf_page" | "docx_embedded";
  sourceLocator: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  width: number;
  height: number;
  data: Buffer;
};

export type StoryAttachment = {
  id: string;
  workspaceId: string;
  projectId: string;
  providerId: StoryAttachmentProviderId;
  canonicalStoryId: string;
  storyDisplayKey: string;
  source: Required<Pick<StoryAttachmentSource, "kind">> & {
    externalAttachmentId: string | null;
    metadata: Record<string, unknown>;
  };
  originalFileName: string;
  mimeType: string;
  fileFormat: DocumentFormat;
  byteSize: number;
  contentHash: string;
  parseStatus: StoryAttachmentParseStatus;
  parseGeneration: number;
  parsedText: string | null;
  parsedSections: StoryAttachmentParsedSection[];
  parseWarnings: string[];
  parseMetadata: Record<string, unknown>;
  parseError: string | null;
  parseRecipeVersion: string | null;
  lifecycleStatus: "active" | "deleted";
  storageCleanupStatus: "not_requested" | "pending" | "completed";
  deletedAt: string | null;
  deletedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateStoryAttachmentResult = {
  attachment: StoryAttachment;
  jobId: string | null;
  reused: boolean;
};

export type StoryAttachmentAiContext = {
  attachment: StoryAttachment;
  text: string;
  sections: StoryAttachmentParsedSection[];
  visuals: StoryAttachmentVisual[];
};

export class StoryAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryAttachmentValidationError";
  }
}

export class StoryAttachmentNotReadyError extends Error {
  constructor() {
    super("The selected attachment is still being processed or could not be processed.");
    this.name = "StoryAttachmentNotReadyError";
  }
}

type StoryAttachmentRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  provider_id: StoryAttachmentProviderId;
  canonical_story_id: string;
  story_display_key: string;
  source_kind: StoryAttachmentSourceKind;
  source_attachment_id: string | null;
  source_metadata_json: unknown;
  original_file_name: string;
  mime_type: string;
  file_format: DocumentFormat;
  byte_size: number | string;
  content_hash: string;
  storage_key: string;
  parse_status: StoryAttachmentParseStatus;
  parse_generation: number;
  parsed_text: string | null;
  parsed_sections_json: unknown;
  parse_warnings_json: unknown;
  parse_metadata_json: unknown;
  parse_error: string | null;
  parse_recipe_version: string | null;
  lifecycle_status: "active" | "deleted";
  storage_cleanup_status: "not_requested" | "pending" | "completed";
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type StoryAttachmentVisualRow = {
  id: string;
  visual_source: StoryAttachmentVisual["source"];
  source_locator: string;
  storage_key: string;
  mime_type: StoryAttachmentVisual["mimeType"];
  byte_size: number | string;
  width: number;
  height: number;
};

export type StoryAttachmentParseTarget = StoryAttachment & {
  storageKey: string;
};

export type PersistStoryAttachmentVisual = Omit<StoryAttachmentVisual, "id" | "data"> & {
  ordinal: number;
  storageKey: string;
};

const ATTACHMENT_SELECT_COLUMNS = `
  id, workspace_id, project_id, provider_id, canonical_story_id, story_display_key,
  source_kind, source_attachment_id, source_metadata_json,
  original_file_name, mime_type, file_format, byte_size, content_hash, storage_key,
  parse_status, parse_generation, parsed_text, parsed_sections_json, parse_warnings_json,
  parse_metadata_json, parse_error, parse_recipe_version,
  lifecycle_status, storage_cleanup_status, deleted_at, deleted_by,
  created_by, created_at, updated_at
`;

let attachmentStorage: StoryAttachmentStorage | undefined;

export function getStoryAttachmentStorage(): StoryAttachmentStorage {
  if (!attachmentStorage) attachmentStorage = createStoryAttachmentStorage();
  return attachmentStorage;
}

/** Test seam. Production callers use the private attachment storage root above. */
export function setStoryAttachmentStorageForTests(storage: StoryAttachmentStorage | undefined): void {
  attachmentStorage = storage;
}

export function assertStoryAttachmentScope(input: StoryAttachmentScope): StoryAttachmentScope {
  const providerId = input.providerId;
  if (!STORY_ATTACHMENT_PROVIDERS.includes(providerId)) {
    throw new StoryAttachmentValidationError("Story attachment provider is invalid.");
  }
  return {
    workspaceId: requiredText(input.workspaceId, "Workspace id"),
    projectId: requiredText(input.projectId, "Project id"),
    providerId,
    canonicalStoryId: requiredText(input.canonicalStoryId, "Canonical story id"),
    storyDisplayKey: requiredText(input.storyDisplayKey, "Story display key"),
  };
}

export async function createStoryAttachment(input: {
  scope: StoryAttachmentScope;
  actor: string;
  source: StoryAttachmentSource;
  fileName: string;
  declaredMimeType?: string | null;
  bytes: StoryAttachmentByteSource;
}): Promise<CreateStoryAttachmentResult> {
  const scope = assertStoryAttachmentScope(input.scope);
  const actor = requiredText(input.actor, "Attachment uploader");
  const source = normalizeSource(input.source);
  const fileName = requiredText(input.fileName, "Attachment file name");
  const bytes = await collectBytes(input.bytes, getDocumentMaxUploadBytes());
  const validation = await validateDocumentUpload({
    fileName,
    data: bytes,
    declaredMimeType: input.declaredMimeType,
  });
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const attachmentId = createId("story_attachment");
  const stored = await getStoryAttachmentStorage().putOriginal({ attachmentId, data: bytes, contentSha256: contentHash });
  const now = nowIso();

  try {
    const result = await withTransaction(async (client) => {
      // The current key is display metadata. Canonical story identity stays the
      // stable group key, so a renamed Jira issue keeps its saved evidence.
      await sqlRun(
        `UPDATE story_attachments
         SET story_display_key = @storyDisplayKey, updated_at = @now
         WHERE workspace_id = @workspaceId
           AND project_id = @projectId
           AND provider_id = @providerId
           AND canonical_story_id = @canonicalStoryId
           AND lifecycle_status = 'active'`,
        { ...scope, now },
        client,
      );
      const row = await sqlGet<StoryAttachmentRow>(
        `INSERT INTO story_attachments (
           id, workspace_id, project_id, provider_id, canonical_story_id, story_display_key,
           source_kind, source_attachment_id, source_metadata_json,
           original_file_name, mime_type, file_format, byte_size, content_hash, storage_key,
           parse_status, parse_generation, created_by, created_at, updated_at
         ) VALUES (
           @id, @workspaceId, @projectId, @providerId, @canonicalStoryId, @storyDisplayKey,
           @sourceKind, @sourceAttachmentId, @sourceMetadataJson::jsonb,
           @originalFileName, @mimeType, @fileFormat, @byteSize, @contentHash, @storageKey,
           'pending', 1, @actor, @now, @now
         ) ON CONFLICT DO NOTHING
         RETURNING ${ATTACHMENT_SELECT_COLUMNS}`,
        {
          id: attachmentId,
          ...scope,
          sourceKind: source.kind,
          sourceAttachmentId: source.externalAttachmentId,
          sourceMetadataJson: JSON.stringify(source.metadata),
          originalFileName: fileName,
          mimeType: canonicalDocumentMimeType(validation.format),
          fileFormat: validation.format,
          byteSize: validation.byteLength,
          contentHash,
          storageKey: stored.storageKey,
          actor,
          now,
        },
        client,
      );
      if (!row) {
        const existing = await findActiveByContent({ scope, contentHash }, client);
        if (!existing) throw new Error("Could not resolve the existing story attachment after deduplication.");
        return { attachment: mapAttachment(existing), jobId: null, reused: true };
      }
      const jobId = await enqueueStoryAttachmentParseJob({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        attachmentId: row.id,
        parseGeneration: row.parse_generation,
        actor,
      }, client);
      return { attachment: mapAttachment(row), jobId, reused: false };
    });
    if (result.reused) await getStoryAttachmentStorage().deleteAttachmentTree(attachmentId);
    return result;
  } catch (error) {
    await getStoryAttachmentStorage().deleteAttachmentTree(attachmentId).catch(() => undefined);
    throw error;
  }
}

export async function listStoryAttachments(input: { scope: StoryAttachmentScope }): Promise<StoryAttachment[]> {
  const scope = assertStoryAttachmentScope(input.scope);
  const rows = await sqlAll<StoryAttachmentRow>(
    `SELECT ${ATTACHMENT_SELECT_COLUMNS}
     FROM story_attachments
     WHERE workspace_id = @workspaceId
       AND project_id = @projectId
       AND provider_id = @providerId
       AND canonical_story_id = @canonicalStoryId
       AND lifecycle_status = 'active'
     ORDER BY created_at DESC, id DESC`,
    scope,
  );
  return rows.map(mapAttachment);
}

export async function getStoryAttachment(input: {
  scope: StoryAttachmentScope;
  attachmentId: string;
}): Promise<StoryAttachment | null> {
  const row = await findActiveById({ scope: assertStoryAttachmentScope(input.scope), attachmentId: input.attachmentId });
  return row ? mapAttachment(row) : null;
}

export async function readStoryAttachmentOriginal(input: {
  scope: StoryAttachmentScope;
  attachmentId: string;
}): Promise<{ attachment: StoryAttachment; data: Buffer } | null> {
  const scope = assertStoryAttachmentScope(input.scope);
  const row = await findActiveById({ scope, attachmentId: input.attachmentId });
  if (!row) return null;
  return { attachment: mapAttachment(row), data: await getStoryAttachmentStorage().read(row.storage_key) };
}

export async function readStoryAttachmentForAi(input: {
  scope: StoryAttachmentScope;
  attachmentId: string;
}): Promise<StoryAttachmentAiContext | null> {
  const scope = assertStoryAttachmentScope(input.scope);
  const row = await findActiveById({ scope, attachmentId: input.attachmentId });
  if (!row) return null;
  const attachment = mapAttachment(row);
  if (attachment.parseStatus !== "parsed" && attachment.parseStatus !== "partially_parsed") {
    throw new StoryAttachmentNotReadyError();
  }
  const visuals = await sqlAll<StoryAttachmentVisualRow>(
    `SELECT id, visual_source, source_locator, storage_key, mime_type, byte_size, width, height
     FROM story_attachment_visuals
     WHERE attachment_id = @attachmentId
       AND parse_generation = @parseGeneration
     ORDER BY ordinal ASC`,
    { attachmentId: attachment.id, parseGeneration: attachment.parseGeneration },
  );
  return {
    attachment,
    text: attachment.parsedText ?? "",
    sections: attachment.parsedSections,
    visuals: await Promise.all(visuals.map(async (visual) => ({
      id: visual.id,
      source: visual.visual_source,
      sourceLocator: visual.source_locator,
      mimeType: visual.mime_type,
      byteSize: numeric(visual.byte_size, "Stored visual size"),
      width: visual.width,
      height: visual.height,
      data: await getStoryAttachmentStorage().read(visual.storage_key),
    }))),
  };
}

export async function retryStoryAttachment(input: {
  scope: StoryAttachmentScope;
  attachmentId: string;
  actor: string;
}): Promise<{ attachment: StoryAttachment; jobId: string | null } | null> {
  const scope = assertStoryAttachmentScope(input.scope);
  const actor = requiredText(input.actor, "Retry actor");
  const attachmentId = requiredText(input.attachmentId, "Attachment id");
  return withTransaction(async (client) => {
    const existing = await sqlGet<Pick<StoryAttachmentRow, "id" | "parse_status" | "parse_generation">>(
      `SELECT id, parse_status, parse_generation
       FROM story_attachments
       WHERE id = @attachmentId
         AND workspace_id = @workspaceId
         AND project_id = @projectId
         AND provider_id = @providerId
         AND canonical_story_id = @canonicalStoryId
         AND lifecycle_status = 'active'
       FOR UPDATE`,
      { ...scope, attachmentId },
      client,
    );
    if (!existing) return null;
    if (existing.parse_status !== "parse_failed") {
      throw new StoryAttachmentValidationError("Only attachments whose processing failed can be retried.");
    }
    const now = nowIso();
    const row = await sqlGet<StoryAttachmentRow>(
      `UPDATE story_attachments
       SET story_display_key = @storyDisplayKey,
           parse_status = 'pending',
           parse_generation = parse_generation + 1,
           parsed_text = NULL,
           parsed_sections_json = '[]'::jsonb,
           parse_warnings_json = '[]'::jsonb,
           parse_metadata_json = '{}'::jsonb,
           parse_error = NULL,
           parse_recipe_version = NULL,
           updated_at = @now
       WHERE id = @attachmentId
         AND workspace_id = @workspaceId
         AND project_id = @projectId
         AND provider_id = @providerId
         AND canonical_story_id = @canonicalStoryId
         AND parse_status = 'parse_failed'
         AND parse_generation = @parseGeneration
         AND lifecycle_status = 'active'
       RETURNING ${ATTACHMENT_SELECT_COLUMNS}`,
      { ...scope, attachmentId, parseGeneration: existing.parse_generation, now },
      client,
    );
    if (!row) throw new StoryAttachmentValidationError("The attachment retry state changed. Refresh and try again.");
    const jobId = await enqueueStoryAttachmentParseJob({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      attachmentId: row.id,
      parseGeneration: row.parse_generation,
      actor,
    }, client);
    return { attachment: mapAttachment(row), jobId };
  });
}

/** Tombstones first. The cleanup worker can safely retry deletion without touching any upstream provider object. */
export async function deleteStoryAttachment(input: {
  scope: StoryAttachmentScope;
  attachmentId: string;
  actor: string;
}): Promise<StoryAttachment | null> {
  const scope = assertStoryAttachmentScope(input.scope);
  const actor = requiredText(input.actor, "Delete actor");
  return withTransaction(async (client) => {
    const now = nowIso();
    const row = await sqlGet<StoryAttachmentRow>(
      `UPDATE story_attachments
       SET lifecycle_status = 'deleted',
           storage_cleanup_status = 'pending',
           deleted_at = @now,
           deleted_by = @actor,
           updated_at = @now
       WHERE id = @attachmentId
         AND workspace_id = @workspaceId
         AND project_id = @projectId
         AND provider_id = @providerId
         AND canonical_story_id = @canonicalStoryId
         AND lifecycle_status = 'active'
       RETURNING ${ATTACHMENT_SELECT_COLUMNS}`,
      { ...scope, attachmentId: requiredText(input.attachmentId, "Attachment id"), actor, now },
      client,
    );
    if (!row) return null;
    await sqlRun(
      `UPDATE jobs
       SET cancel_requested_at = COALESCE(cancel_requested_at, @now), updated_at = @now
       WHERE workspace_id = @workspaceId
         AND project_id = @projectId
         AND job_type = @jobType
         AND status IN ('pending', 'running')
         AND payload_json::jsonb ->> 'attachmentId' = @attachmentId`,
      { workspaceId: scope.workspaceId, projectId: scope.projectId, jobType: STORY_ATTACHMENT_PARSE, attachmentId: row.id, now },
      client,
    );
    await enqueueStoryAttachmentCleanupJob({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      attachmentId: row.id,
      actor,
    }, client);
    return mapAttachment(row);
  });
}

/** Worker-only state transition. A stale generation or tombstone is a harmless no-op. */
export async function beginStoryAttachmentParse(input: {
  attachmentId: string;
  parseGeneration: number;
}): Promise<StoryAttachmentParseTarget | null> {
  return withTransaction(async (client) => {
    const row = await sqlGet<StoryAttachmentRow>(
      `SELECT ${ATTACHMENT_SELECT_COLUMNS}
       FROM story_attachments
       WHERE id = @attachmentId
         AND parse_generation = @parseGeneration
         AND lifecycle_status = 'active'
       FOR UPDATE`,
      { attachmentId: requiredText(input.attachmentId, "Attachment id"), parseGeneration: positiveInteger(input.parseGeneration, "Parse generation") },
      client,
    );
    if (!row) return null;
    const now = nowIso();
    // A retry can only follow a failed generation. Remove any rows from prior
    // generations before the worker writes the replacement generation, so old
    // source/orphaned visual references cannot accumulate indefinitely.
    await sqlRun(
      `DELETE FROM story_attachment_visuals
       WHERE attachment_id = @attachmentId
         AND parse_generation < @parseGeneration`,
      { attachmentId: row.id, parseGeneration: row.parse_generation },
      client,
    );
    await sqlRun(
      `UPDATE story_attachments
       SET parse_status = 'parsing', parse_error = NULL, updated_at = @now
       WHERE id = @attachmentId AND parse_generation = @parseGeneration AND lifecycle_status = 'active'`,
      { attachmentId: row.id, parseGeneration: row.parse_generation, now },
      client,
    );
    return { ...mapAttachment({ ...row, parse_status: "parsing", parse_error: null, updated_at: now }), storageKey: row.storage_key };
  });
}

export async function completeStoryAttachmentParse(input: {
  attachmentId: string;
  parseGeneration: number;
  status: "parsed" | "partially_parsed";
  parsedText: string;
  sections: StoryAttachmentParsedSection[];
  warnings: string[];
  metadata: Record<string, unknown>;
  recipeVersion: string;
  visuals: PersistStoryAttachmentVisual[];
}): Promise<boolean> {
  return withTransaction(async (client) => {
    const row = await sqlGet<{ id: string }>(
      `SELECT id FROM story_attachments
       WHERE id = @attachmentId
         AND parse_generation = @parseGeneration
         AND lifecycle_status = 'active'
       FOR UPDATE`,
      { attachmentId: requiredText(input.attachmentId, "Attachment id"), parseGeneration: positiveInteger(input.parseGeneration, "Parse generation") },
      client,
    );
    if (!row) return false;
    const now = nowIso();
    await sqlRun(
      `DELETE FROM story_attachment_visuals
       WHERE attachment_id = @attachmentId AND parse_generation = @parseGeneration`,
      { attachmentId: input.attachmentId, parseGeneration: input.parseGeneration },
      client,
    );
    for (const visual of input.visuals) {
      await sqlRun(
        `INSERT INTO story_attachment_visuals (
           id, attachment_id, parse_generation, ordinal, visual_source, source_locator,
           storage_key, mime_type, byte_size, width, height, created_at
         ) VALUES (
           @id, @attachmentId, @parseGeneration, @ordinal, @visualSource, @sourceLocator,
           @storageKey, @mimeType, @byteSize, @width, @height, @now
         )`,
        {
          id: createId("story_attachment_visual"),
          attachmentId: input.attachmentId,
          parseGeneration: input.parseGeneration,
          ordinal: nonNegativeInteger(visual.ordinal, "Visual ordinal"),
          visualSource: visual.source,
          sourceLocator: requiredText(visual.sourceLocator, "Visual source locator"),
          storageKey: requiredText(visual.storageKey, "Visual storage key"),
          mimeType: visual.mimeType,
          byteSize: positiveInteger(visual.byteSize, "Visual byte size"),
          width: positiveInteger(visual.width, "Visual width"),
          height: positiveInteger(visual.height, "Visual height"),
          now,
        },
        client,
      );
    }
    await sqlRun(
      `UPDATE story_attachments
       SET parse_status = @status,
           parsed_text = @parsedText,
           parsed_sections_json = @sectionsJson::jsonb,
           parse_warnings_json = @warningsJson::jsonb,
           parse_metadata_json = @metadataJson::jsonb,
           parse_error = NULL,
           parse_recipe_version = @recipeVersion,
           updated_at = @now
       WHERE id = @attachmentId
         AND parse_generation = @parseGeneration
         AND lifecycle_status = 'active'`,
      {
        attachmentId: input.attachmentId,
        parseGeneration: input.parseGeneration,
        status: input.status,
        parsedText: input.parsedText,
        sectionsJson: JSON.stringify(normalizeSections(input.sections)),
        warningsJson: JSON.stringify(normalizeWarnings(input.warnings)),
        metadataJson: JSON.stringify(normalizeMetadata(input.metadata)),
        recipeVersion: requiredText(input.recipeVersion, "Parse recipe version"),
        now,
      },
      client,
    );
    return true;
  });
}

export async function failStoryAttachmentParse(input: {
  attachmentId: string;
  parseGeneration: number;
  errorMessage: string;
}): Promise<boolean> {
  const updated = await sqlRun(
    `UPDATE story_attachments
     SET parse_status = 'parse_failed', parse_error = @parseError, updated_at = @now
     WHERE id = @attachmentId
       AND parse_generation = @parseGeneration
       AND lifecycle_status = 'active'`,
    {
      attachmentId: requiredText(input.attachmentId, "Attachment id"),
      parseGeneration: positiveInteger(input.parseGeneration, "Parse generation"),
      parseError: requiredText(input.errorMessage, "Parse error").slice(0, 1_000),
      now: nowIso(),
    },
  );
  return updated > 0;
}

export async function getStoryAttachmentCleanupTarget(input: { attachmentId: string }): Promise<{ attachmentId: string } | null> {
  const row = await sqlGet<{ id: string }>(
    `SELECT id FROM story_attachments
     WHERE id = @attachmentId
       AND lifecycle_status = 'deleted'
       AND storage_cleanup_status = 'pending'`,
    { attachmentId: requiredText(input.attachmentId, "Attachment id") },
  );
  return row ? { attachmentId: row.id } : null;
}

export async function completeStoryAttachmentStorageCleanup(input: { attachmentId: string }): Promise<boolean> {
  return (await sqlRun(
    `UPDATE story_attachments
     SET storage_cleanup_status = 'completed', updated_at = @now
     WHERE id = @attachmentId
       AND lifecycle_status = 'deleted'
       AND storage_cleanup_status = 'pending'`,
    { attachmentId: requiredText(input.attachmentId, "Attachment id"), now: nowIso() },
  )) > 0;
}

function findActiveByContent(input: { scope: StoryAttachmentScope; contentHash: string }, client?: PoolClient) {
  return sqlGet<StoryAttachmentRow>(
    `SELECT ${ATTACHMENT_SELECT_COLUMNS}
     FROM story_attachments
     WHERE workspace_id = @workspaceId
       AND project_id = @projectId
       AND provider_id = @providerId
       AND canonical_story_id = @canonicalStoryId
       AND content_hash = @contentHash
       AND lifecycle_status = 'active'
     LIMIT 1`,
    { ...input.scope, contentHash: input.contentHash },
    client,
  );
}

function findActiveById(input: { scope: StoryAttachmentScope; attachmentId: string }, client?: PoolClient) {
  return sqlGet<StoryAttachmentRow>(
    `SELECT ${ATTACHMENT_SELECT_COLUMNS}
     FROM story_attachments
     WHERE id = @attachmentId
       AND workspace_id = @workspaceId
       AND project_id = @projectId
       AND provider_id = @providerId
       AND canonical_story_id = @canonicalStoryId
       AND lifecycle_status = 'active'
     LIMIT 1`,
    { ...input.scope, attachmentId: requiredText(input.attachmentId, "Attachment id") },
    client,
  );
}

function mapAttachment(row: StoryAttachmentRow): StoryAttachment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    providerId: row.provider_id,
    canonicalStoryId: row.canonical_story_id,
    storyDisplayKey: row.story_display_key,
    source: {
      kind: row.source_kind,
      externalAttachmentId: row.source_attachment_id,
      metadata: jsonRecord(row.source_metadata_json),
    },
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileFormat: row.file_format,
    byteSize: numeric(row.byte_size, "Attachment byte size"),
    contentHash: row.content_hash,
    parseStatus: row.parse_status,
    parseGeneration: positiveInteger(row.parse_generation, "Parse generation"),
    parsedText: row.parsed_text,
    parsedSections: normalizeSections(jsonArray(row.parsed_sections_json)),
    parseWarnings: normalizeWarnings(jsonArray(row.parse_warnings_json)),
    parseMetadata: jsonRecord(row.parse_metadata_json),
    parseError: row.parse_error,
    parseRecipeVersion: row.parse_recipe_version,
    lifecycleStatus: row.lifecycle_status,
    storageCleanupStatus: row.storage_cleanup_status,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function collectBytes(source: StoryAttachmentByteSource, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  const iterable: AsyncIterable<Uint8Array> = source instanceof Uint8Array
    ? (async function* () { yield source; })()
    : source;
  for await (const value of iterable) {
    const chunk = Buffer.from(value);
    byteSize += chunk.byteLength;
    if (byteSize > maxBytes) {
      throw new StoryAttachmentValidationError(`The upload exceeds the ${maxBytes.toLocaleString()} byte size limit.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteSize);
}

function normalizeSource(input: StoryAttachmentSource): Required<Pick<StoryAttachmentSource, "kind">> & {
  externalAttachmentId: string | null;
  metadata: Record<string, unknown>;
} {
  if (!STORY_ATTACHMENT_SOURCE_KINDS.includes(input.kind)) {
    throw new StoryAttachmentValidationError("Story attachment source is invalid.");
  }
  const externalAttachmentId = optionalText(input.externalAttachmentId, "Provider attachment id");
  if (input.kind === "upload" && externalAttachmentId !== null) {
    throw new StoryAttachmentValidationError("Uploaded attachments cannot include a provider attachment id.");
  }
  if (input.kind !== "upload" && externalAttachmentId === null) {
    throw new StoryAttachmentValidationError("Imported attachments require their provider attachment id.");
  }
  return { kind: input.kind, externalAttachmentId, metadata: normalizeMetadata(input.metadata) };
}

function normalizeSections(input: unknown): StoryAttachmentParsedSection[] {
  if (!Array.isArray(input)) return [];
  const sections: StoryAttachmentParsedSection[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (typeof value.sectionKey !== "string" || !value.sectionKey.trim() || typeof value.kind !== "string" || typeof value.text !== "string") continue;
    const pageNumber = typeof value.pageNumber === "number" && Number.isSafeInteger(value.pageNumber) && value.pageNumber > 0
      ? value.pageNumber
      : undefined;
    sections.push({
      sectionKey: value.sectionKey.trim(),
      kind: value.kind,
      text: value.text,
      ...(pageNumber ? { pageNumber } : {}),
      ...(value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? { metadata: normalizeMetadata(value.metadata) } : {}),
    });
  }
  return sections;
}

function normalizeWarnings(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean).map((value) => value.slice(0, 1_000));
}

function normalizeMetadata(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new StoryAttachmentValidationError("Story attachment metadata must be a JSON object.");
  }
  try {
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  } catch {
    throw new StoryAttachmentValidationError("Story attachment metadata must be JSON-serializable.");
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return jsonRecord(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try { return jsonArray(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new StoryAttachmentValidationError(`${label} is required.`);
  return value.trim();
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new StoryAttachmentValidationError(`${label} must be text.`);
  return value.trim() || null;
}

function numeric(value: number | string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new StoryAttachmentValidationError(`${label} is invalid.`);
  return number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new StoryAttachmentValidationError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StoryAttachmentValidationError(`${label} must be a non-negative integer.`);
  return value;
}

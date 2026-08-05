import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSession } from "@/modules/auth/session.service";
import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
  type WorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import {
  ProjectSourceDocumentLifecycleError,
  ProjectSourceDocumentNotFoundError,
  ProjectSourceDocumentValidationError,
  getProjectSourceDocumentVersion,
  updateVersionParseState,
  type ProjectSourceDocument,
  type ProjectSourceDocumentLifecycleStatus,
  type ProjectSourceDocumentVersion,
} from "@/modules/documents/project-source-documents.service";
import { isDocumentParseError } from "@/modules/documents/parsed-document.types";
import { StorageObjectNotFoundError } from "@/modules/documents/storage/storage-backend.port";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";
import { sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const DOCUMENT_LIST_PAGE_SIZE_DEFAULT = 25;
export const DOCUMENT_LIST_PAGE_SIZE_MAX = 100;
export const DOCUMENT_CONTENT_PAGE_SIZE_DEFAULT = 50;
export const DOCUMENT_CONTENT_PAGE_SIZE_MAX = 100;
export const DOCUMENT_UPLOAD_RATE_LIMIT = 20;
export const DOCUMENT_UPLOAD_RATE_WINDOW_MS = 5 * 60 * 1000;

export type TrustedDocumentRouteScope = {
  ctx: WorkflowContext;
  scope: ProjectScope;
};

export type DocumentPagination = {
  page: number;
  pageSize: number;
  offset: number;
};

export type DocumentListFilters = {
  lifecycleStatus?: ProjectSourceDocumentLifecycleStatus;
  search?: string;
};

export type DocumentListItem = {
  document: ProjectSourceDocument;
  currentVersion: (ProjectSourceDocumentVersion & { uploadedByDisplayName?: string }) | null;
  versionCount: number;
};

export type DocumentUploadFields = {
  scope: ProjectScope;
  title?: string;
  description?: string;
  tags: string[];
  languageHint?: string;
};

const PaginationInputSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});

const DocumentListFilterSchema = z.object({
  lifecycleStatus: z.enum(["active", "archived"]).optional(),
  search: z.string().trim().max(500).optional(),
});

const DocumentUploadMetadataSchema = z.object({
  scope: ProjectScopeSchema,
  title: z.string().trim().min(1).max(512).optional(),
  description: z.string().trim().max(10_000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  languageHint: z.string().trim().max(64).optional(),
});

/** Parse the JSON-encoded scope used by read endpoints without trusting it. */
export function parseDocumentScopeParam(value: string | null):
  | { success: true; data: ProjectScope }
  | { success: false; error: string } {
  if (!value?.trim()) return { success: false, error: "A project scope is required." };
  try {
    const parsed = ProjectScopeSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return { success: false, error: "A valid project scope is required." };
    return { success: true, data: parsed.data };
  } catch {
    return { success: false, error: "The project scope must be valid JSON." };
  }
}

export function parseDocumentPagination(input: {
  page?: string | number | null;
  pageSize?: string | number | null;
  defaultPageSize?: number;
  maxPageSize?: number;
}): { success: true; data: DocumentPagination } | { success: false; error: string } {
  const page = toPositiveInteger(input.page, 1);
  const pageSize = toPositiveInteger(input.pageSize, input.defaultPageSize ?? DOCUMENT_LIST_PAGE_SIZE_DEFAULT);
  const maxPageSize = input.maxPageSize ?? DOCUMENT_LIST_PAGE_SIZE_MAX;
  const parsed = PaginationInputSchema.safeParse({ page, pageSize });
  if (!parsed.success || parsed.data.pageSize > maxPageSize) {
    return { success: false, error: `page must be a positive integer and pageSize must be between 1 and ${maxPageSize}.` };
  }
  return {
    success: true,
    data: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      offset: (parsed.data.page - 1) * parsed.data.pageSize,
    },
  };
}

export function parseDocumentListFilters(input: {
  lifecycleStatus?: string | null;
  search?: string | null;
}): { success: true; data: DocumentListFilters } | { success: false; error: string } {
  const parsed = DocumentListFilterSchema.safeParse({
    lifecycleStatus: input.lifecycleStatus ?? undefined,
    search: input.search?.trim() || undefined,
  });
  if (!parsed.success) return { success: false, error: "Document list filters are invalid." };
  return { success: true, data: parsed.data };
}

/** Resolve both workspace membership and the canonical project anchor. */
export async function resolveDocumentReadScope(scopeInput: ProjectScope): Promise<TrustedDocumentRouteScope> {
  const ctx = await requireWorkflowContext(scopeInput.workspaceId);
  const scope = await resolveProjectScope(ctx, scopeInput);
  return { ctx, scope };
}

/** Source mutations are owner/admin-only, while read routes are member-safe. */
export async function resolveDocumentMutationScope(
  scopeInput: ProjectScope,
  message = "Only workspace owners and admins can manage source documents.",
): Promise<TrustedDocumentRouteScope> {
  const context = await resolveDocumentReadScope(scopeInput);
  await requireWorkflowRole(context.ctx, ["owner", "admin"], message);
  return context;
}

/**
 * Multipart fields are strings and may have come from an arbitrary client.
 * Validate them separately from the streamed file data; only the expected field
 * names are accepted so no hidden per-file path or metadata fields exist.
 */
export function parseDocumentUploadFields(fields: Record<string, string>):
  | { success: true; data: DocumentUploadFields }
  | { success: false; error: string } {
  const allowed = new Set(["scope", "title", "description", "tags", "languageHint"]);
  const unexpected = Object.keys(fields).find((key) => !allowed.has(key));
  if (unexpected) return { success: false, error: `Unexpected multipart field: ${unexpected}.` };

  let scope: unknown;
  let tags: unknown = undefined;
  try {
    scope = JSON.parse(fields.scope ?? "");
  } catch {
    return { success: false, error: "The project scope must be valid JSON." };
  }
  if (fields.tags?.trim()) {
    try {
      tags = JSON.parse(fields.tags);
    } catch {
      return { success: false, error: "tags must be a JSON array of text values." };
    }
  }

  const parsed = DocumentUploadMetadataSchema.safeParse({
    scope,
    title: emptyToUndefined(fields.title),
    description: emptyToUndefined(fields.description),
    tags,
    languageHint: emptyToUndefined(fields.languageHint),
  });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Document upload metadata is invalid." };
  }
  return {
    success: true,
    data: {
      ...parsed.data,
      tags: parsed.data.tags ?? [],
    },
  };
}

/** Count before pagination so the Documents Hub can render stable page controls. */
export async function countProjectSourceDocuments(input: {
  scope: ProjectScope;
  filters: DocumentListFilters;
}): Promise<number> {
  const params: Record<string, unknown> = {
    workspaceId: input.scope.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
  };
  const clauses = [
    "workspace_id = @workspaceId",
    "project_id = @projectId",
    "azure_project_id = @azureProjectId",
  ];
  if (input.filters.lifecycleStatus) {
    params.lifecycleStatus = input.filters.lifecycleStatus;
    clauses.push("lifecycle_status = @lifecycleStatus");
  }
  if (input.filters.search) {
    params.search = `%${input.filters.search}%`;
    clauses.push("(document_name ILIKE @search OR COALESCE(description, '') ILIKE @search)");
  }
  const row = await sqlGet<{ total_count: number | string }>(
    `SELECT COUNT(*) AS total_count FROM project_source_documents WHERE ${clauses.join(" AND ")}`,
    params,
  );
  return safeCount(row?.total_count);
}

/**
 * uploaded_by stores the immutable user id; display names live on the users
 * row and may change, so they are resolved at read time only. A missing user
 * row (deleted account) keeps rendering as the stored id rather than hiding
 * who uploaded the version.
 */
export async function resolveUserDisplayNames(userIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (!ids.length) return new Map();
  const rows = await sqlAll<{ id: string; display_name: string | null; email_or_unique_name: string | null }>(
    `SELECT id, display_name, email_or_unique_name FROM users WHERE id = ANY(@ids::text[])`,
    { ids },
  );
  return new Map(rows.map((row) => [row.id, row.display_name?.trim() || row.email_or_unique_name?.trim() || row.id]));
}

/**
 * Keep list rows useful without making the browser issue N follow-up requests.
 * Version ids are still loaded through the scoped service, while a grouped query
 * provides an exact count even for documents with more than the UI's history cap.
 */
export async function enrichProjectSourceDocumentList(input: {
  scope: ProjectScope;
  documents: ProjectSourceDocument[];
}): Promise<DocumentListItem[]> {
  if (!input.documents.length) return [];
  const documentIds = input.documents.map((document) => document.id);
  const countRows = await sqlAll<{ document_id: string; version_count: number | string }>(
    `
      SELECT document_id, COUNT(*) AS version_count
      FROM project_source_document_versions
      WHERE workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND document_id = ANY(@documentIds::text[])
      GROUP BY document_id
    `,
    {
      workspaceId: input.scope.workspaceId,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      documentIds,
    },
  );
  const countByDocumentId = new Map(countRows.map((row) => [row.document_id, safeCount(row.version_count)]));
  const currentVersions = await Promise.all(input.documents.map(async (document) => (
    document.currentVersionId
      ? getProjectSourceDocumentVersion({ scope: input.scope, versionId: document.currentVersionId })
      : undefined
  )));
  const uploaderNames = await resolveUserDisplayNames(currentVersions.map((version) => version?.uploadedBy));
  return input.documents.map((document, index) => {
    const currentVersion = currentVersions[index] ?? null;
    return {
      document,
      currentVersion: currentVersion
        ? { ...currentVersion, uploadedByDisplayName: uploaderNames.get(currentVersion.uploadedBy) }
        : null,
      versionCount: countByDocumentId.get(document.id) ?? 0,
    };
  });
}

/** Count a version's chunks only after the caller has scope-validated the version. */
export async function countProjectSourceDocumentVersionChunks(input: {
  scope: ProjectScope;
  documentId: string;
  versionId: string;
}): Promise<number> {
  const row = await sqlGet<{ total_count: number | string }>(
    `
      SELECT COUNT(*) AS total_count
      FROM document_chunks
      WHERE workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND source_type = 'uploaded_document'
        AND document_id = @documentId
        AND source_document_version_id = @versionId
    `,
    {
      workspaceId: input.scope.workspaceId,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      documentId: input.documentId,
      versionId: input.versionId,
    },
  );
  return safeCount(row?.total_count);
}

export async function documentUploadRateLimitResponse(request: Request): Promise<NextResponse | null> {
  const rate = await checkRateLimit(
    `document-upload:${clientIp(request)}`,
    DOCUMENT_UPLOAD_RATE_LIMIT,
    DOCUMENT_UPLOAD_RATE_WINDOW_MS,
  );
  if (rate.allowed) return null;
  return NextResponse.json(
    { error: "Too many document uploads. Please wait and try again." },
    { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
  );
}

/**
 * A cheap session check that MUST run before an upload route streams the
 * multipart body: parsing it means writing every file to a temp path and
 * hashing it with SHA-256, real disk/CPU cost that an unauthenticated caller
 * must not be able to force merely by staying under the IP rate limit. Full
 * owner/admin role enforcement still happens afterward, once the `scope`
 * multipart field has been parsed, via {@link resolveDocumentMutationScope} —
 * that check cannot move earlier because scope arrives inside the body.
 */
export async function documentUploadSessionResponse(): Promise<NextResponse | null> {
  try {
    await requireSession();
    return null;
  } catch (error) {
    return documentAuthOrErrorResponse(error, "Sign in to manage source documents.");
  }
}

/**
 * A job-queue enqueue failure after the version row is already committed must
 * never leave it silently 'pending' forever with no operator-visible signal.
 * Record it as a terminal parse_failed state with a message the Reprocess
 * action can retry from. This is best-effort: a secondary failure to write
 * this bookkeeping state must not mask the original enqueue error for the caller.
 */
export async function markDocumentVersionEnqueueFailed(input: {
  scope: ProjectScope;
  versionId: string;
  reason: string;
}): Promise<void> {
  try {
    await updateVersionParseState({
      scope: input.scope,
      versionId: input.versionId,
      parseStatus: "parse_failed",
      parseError: `Processing could not be queued: ${input.reason}. Use Reprocess to retry.`,
      parseWarnings: [],
      chunkCount: 0,
    });
  } catch (error) {
    console.error("Failed to mark a document version parse_failed after an enqueue failure.", error);
  }
}

export function documentRouteErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof ProjectSourceDocumentNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ProjectSourceDocumentLifecycleError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ProjectSourceDocumentValidationError || isDocumentParseError(error)) {
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  // Storage keys are intentionally opaque implementation details. Do not turn a
  // missing local/object-store blob into a technical response containing one.
  if (error instanceof StorageObjectNotFoundError) {
    return NextResponse.json({ error: "The stored document object is unavailable." }, { status: 404 });
  }
  return routeErrorResponse(error, { domain: "generic", fallback });
}

export function documentAuthOrErrorResponse(error: unknown, fallback: string): NextResponse {
  return authErrorResponse(error) ?? documentRouteErrorResponse(error, fallback);
}

/** Keep raw filenames out of headers; storage itself never receives this value as a path. */
export function safeDocumentDownloadName(fileName: string, fallback = "document") {
  const cleaned = fileName
    .replace(/[\\/\u0000-\u001F\u007F"]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/**
 * The bare `filename=` parameter must be pure ASCII: `Headers`/`Response`
 * reject any code point above U+00FF as an invalid ByteString, so a raw
 * smart-quote, Arabic, or CJK name there would throw and 500 the download.
 * Non-ASCII characters become '_', the extension is preserved, and repeated
 * placeholders collapse so the result stays readable and is never empty.
 */
export function asciiDocumentDownloadFallbackName(fileName: string, fallback = "document"): string {
  const extensionMatch = fileName.match(/\.[A-Za-z0-9]{1,12}$/);
  const extension = extensionMatch ? extensionMatch[0] : "";
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  const asciiBase = base
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (asciiBase) return `${asciiBase}${extension}`;
  return extension ? `${fallback}${extension}` : fallback;
}

export function documentDownloadHeaders(input: { fileName: string; byteSize: number }) {
  const fileName = safeDocumentDownloadName(input.fileName);
  const asciiFileName = asciiDocumentDownloadFallbackName(fileName);
  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(input.byteSize),
    // filename*= (RFC 5987) carries the real name for clients that honor it;
    // filename= is the ASCII-safe fallback so header construction cannot throw.
    "Content-Disposition": `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

export function displayDocumentNameFromFileName(fileName: string, fallback = "Uploaded document") {
  const safeName = safeDocumentDownloadName(fileName, fallback);
  const withoutExtension = safeName.replace(/\.[A-Za-z0-9]{1,12}$/, "").trim();
  return (withoutExtension || fallback).slice(0, 512);
}

function toPositiveInteger(value: string | number | null | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : Number.NaN;
}

function safeCount(value: number | string | undefined) {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function emptyToUndefined(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

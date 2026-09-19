"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, RefreshCw, Trash2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { Callout } from "@/components/qa/callout";
import { cn } from "@/lib/utils";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import { caughtErrorMessage } from "@/shared/lib/api-error-message";

import { postForm, postJson, readJsonResponse } from "./post-json";

export type StoryAttachmentsPanelProps = {
  scope: ActiveProjectScope | null;
  targetWorkItemId: string;
  selectedAttachmentIds?: string[];
  onSelectedAttachmentIdsChange: (ids: string[]) => void;
  onAttachmentsChanged: () => void;
};

type StoryAttachment = {
  id: string;
  originalFileName: string;
  mimeType: string | null;
  byteSize: number | null;
  parseStatus: string;
  parseWarnings: string[];
  parseError: string | null;
  source: { kind: string };
};

type SourceAttachment = {
  id: string;
  fileName: string;
  contentType: string | null;
  size: number | null;
  createdAt: string | null;
};

type StoryAttachmentUploadResponse = {
  uploads?: unknown;
  failures?: unknown;
};

type LoadingState<T> = {
  loading: boolean;
  error: string | null;
  data: T;
  contextKey: string | null;
};

const EMPTY_SAVED_ATTACHMENTS: LoadingState<StoryAttachment[]> = { loading: false, error: null, data: [], contextKey: null };
const EMPTY_SOURCE_ATTACHMENTS: LoadingState<SourceAttachment[]> = { loading: false, error: null, data: [], contextKey: null };
const ACCEPTED_ATTACHMENT_TYPES = ".pdf,.docx,.xlsx,.csv,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp";
const STORY_ATTACHMENT_POLL_INTERVAL_MS = 2_000;

export function StoryAttachmentsPanel({
  scope,
  targetWorkItemId,
  selectedAttachmentIds = [],
  onSelectedAttachmentIdsChange,
  onAttachmentsChanged,
}: StoryAttachmentsPanelProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const savedRequestVersionRef = useRef(0);
  const sourceRequestVersionRef = useRef(0);
  const [savedAttachments, setSavedAttachments] = useState<LoadingState<StoryAttachment[]>>(EMPTY_SAVED_ATTACHMENTS);
  const [sourceAttachments, setSourceAttachments] = useState<LoadingState<SourceAttachment[]>>(EMPTY_SOURCE_ATTACHMENTS);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StoryAttachment | null>(null);
  const normalizedWorkItemId = targetWorkItemId.trim();
  const readyForAttachments = Boolean(scope && normalizedWorkItemId);
  const attachmentContextKey = storyAttachmentContextKey(scope, normalizedWorkItemId);

  const loadSavedAttachments = useCallback(async (silent = false) => {
    const requestVersion = ++savedRequestVersionRef.current;
    const contextKey = storyAttachmentContextKey(scope, normalizedWorkItemId);
    if (!scope || !normalizedWorkItemId || !contextKey) {
      setSavedAttachments(EMPTY_SAVED_ATTACHMENTS);
      return;
    }
    if (!silent) {
      setSavedAttachments((current) => current.contextKey === contextKey
        ? { ...current, loading: true, error: null }
        : { loading: true, error: null, data: [], contextKey });
    }
    try {
      const response = await getJson<unknown>(storyAttachmentUrl("/api/story-attachments", scope, normalizedWorkItemId));
      if (requestVersion !== savedRequestVersionRef.current) return;
      setSavedAttachments({ loading: false, error: null, data: attachmentList(response), contextKey });
    } catch (error) {
      if (requestVersion !== savedRequestVersionRef.current) return;
      setSavedAttachments({ loading: false, error: caughtErrorMessage(error, "Could not load story attachments."), data: [], contextKey });
    }
  }, [normalizedWorkItemId, scope]);

  const loadSourceAttachments = useCallback(async () => {
    const requestVersion = ++sourceRequestVersionRef.current;
    const contextKey = storyAttachmentContextKey(scope, normalizedWorkItemId);
    if (!scope || !normalizedWorkItemId || !contextKey) {
      setSourceAttachments(EMPTY_SOURCE_ATTACHMENTS);
      return;
    }
    setSourceAttachments((current) => current.contextKey === contextKey
      ? { ...current, loading: true, error: null }
      : { loading: true, error: null, data: [], contextKey });
    try {
      const response = await getJson<unknown>(storyAttachmentUrl("/api/story-attachments/source", scope, normalizedWorkItemId));
      if (requestVersion !== sourceRequestVersionRef.current) return;
      setSourceAttachments({ loading: false, error: null, data: sourceAttachmentList(response), contextKey });
    } catch (error) {
      if (requestVersion !== sourceRequestVersionRef.current) return;
      setSourceAttachments({ loading: false, error: caughtErrorMessage(error, "Could not load linked attachments."), data: [], contextKey });
    }
  }, [normalizedWorkItemId, scope]);

  useEffect(() => {
    setSourceOpen(false);
    setSourceAttachments(EMPTY_SOURCE_ATTACHMENTS);
    setActionError(null);
    void loadSavedAttachments();
  }, [loadSavedAttachments]);

  useEffect(() => {
    if (
      !attachmentContextKey
      || savedAttachments.contextKey !== attachmentContextKey
      || savedAttachments.loading
      || savedAttachments.error
      || !savedAttachments.data.some(isProcessingAttachment)
    ) return;
    const interval = window.setInterval(() => void loadSavedAttachments(true), STORY_ATTACHMENT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [attachmentContextKey, loadSavedAttachments, savedAttachments.contextKey, savedAttachments.data, savedAttachments.error, savedAttachments.loading]);

  useEffect(() => {
    if (!attachmentContextKey || savedAttachments.contextKey !== attachmentContextKey || savedAttachments.loading || savedAttachments.error) return;
    const availableIds = new Set(savedAttachments.data.filter(isSelectableAttachment).map((attachment) => attachment.id));
    const nextIds = selectedAttachmentIds.filter((id) => availableIds.has(id));
    if (nextIds.length !== selectedAttachmentIds.length) onSelectedAttachmentIdsChange(nextIds);
  }, [attachmentContextKey, onSelectedAttachmentIdsChange, savedAttachments.contextKey, savedAttachments.data, savedAttachments.error, savedAttachments.loading, selectedAttachmentIds]);

  function toggleSelection(attachment: StoryAttachment, checked: boolean) {
    if (!isSelectableAttachment(attachment)) return;
    const selected = new Set(selectedAttachmentIds);
    if (checked) selected.add(attachment.id);
    else selected.delete(attachment.id);
    onSelectedAttachmentIdsChange(savedAttachments.data
      .map((item) => item.id)
      .filter((id) => selected.has(id)));
  }

  async function uploadFiles(files: File[]) {
    if (!scope || !normalizedWorkItemId || !files.length || uploading) return;
    setUploading(true);
    setActionError(null);
    try {
      const formData = new FormData();
      // Multipart parser requires both scope fields before it starts receiving files.
      formData.append("scope", JSON.stringify(scope));
      formData.append("workItemId", normalizedWorkItemId);
      for (const file of files) formData.append("files", file);
      const result = await postForm<StoryAttachmentUploadResponse>("/api/story-attachments", formData);
      const failures = uploadFailures(result);
      if (failures.length) {
        setActionError(uploadFailureMessage(failures));
      }
      onAttachmentsChanged();
      await loadSavedAttachments(true);
    } catch (error) {
      setActionError(caughtErrorMessage(error, "Could not upload the selected attachments."));
    } finally {
      setUploading(false);
    }
  }

  async function importSourceAttachment(attachmentId: string) {
    if (!scope || !normalizedWorkItemId || busyAction) return;
    setBusyAction(`import:${attachmentId}`);
    setActionError(null);
    try {
      await postJson<unknown>("/api/story-attachments/import", {
        scope,
        workItemId: normalizedWorkItemId,
        attachmentId,
      });
      onAttachmentsChanged();
      await loadSavedAttachments(true);
    } catch (error) {
      setActionError(caughtErrorMessage(error, "Could not import the linked attachment."));
    } finally {
      setBusyAction(null);
    }
  }

  async function retryAttachment(attachmentId: string) {
    if (!scope || !normalizedWorkItemId || busyAction) return;
    setBusyAction(`retry:${attachmentId}`);
    setActionError(null);
    try {
      await postJson<unknown>(`/api/story-attachments/${encodeURIComponent(attachmentId)}/retry`, {
        scope,
        workItemId: normalizedWorkItemId,
      });
      onAttachmentsChanged();
      await loadSavedAttachments(true);
    } catch (error) {
      setActionError(caughtErrorMessage(error, "Could not retry attachment processing."));
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteAttachment() {
    if (!scope || !normalizedWorkItemId || !deleteTarget || busyAction) return;
    const attachmentId = deleteTarget.id;
    setBusyAction(`delete:${attachmentId}`);
    setActionError(null);
    try {
      await deleteJson<unknown>(`/api/story-attachments/${encodeURIComponent(attachmentId)}`, {
        scope,
        workItemId: normalizedWorkItemId,
      });
      onSelectedAttachmentIdsChange(selectedAttachmentIds.filter((id) => id !== attachmentId));
      onAttachmentsChanged();
      setDeleteTarget(null);
      await loadSavedAttachments(true);
    } catch (error) {
      setActionError(caughtErrorMessage(error, "Could not remove the saved attachment."));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section aria-labelledby={`${inputId}-title`} className="space-y-3 rounded-lg border border-border bg-muted/25 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id={`${inputId}-title`} className="text-sm font-semibold text-foreground">Attachments for this run</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Add reference files, screenshots, or UX designs. Only processed files are sent to the AI.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void loadSavedAttachments()}
          disabled={!readyForAttachments || savedAttachments.loading || uploading}
        >
          <RefreshCw className={cn("size-3.5", savedAttachments.loading && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {!readyForAttachments ? (
        <Callout tone="info" role="status">Enter a work item ID before attaching files.</Callout>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              id={inputId}
              type="file"
              multiple
              accept={ACCEPTED_ATTACHMENT_TYPES}
              className="sr-only"
              aria-label="Upload files for AI context"
              onChange={(event) => {
                void uploadFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Upload className="size-3.5" />}
              {uploading ? "Uploading…" : "Upload files"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={sourceOpen}
              onClick={() => {
                const nextOpen = !sourceOpen;
                setSourceOpen(nextOpen);
                if (nextOpen && !sourceAttachments.data.length && !sourceAttachments.loading) void loadSourceAttachments();
              }}
              disabled={uploading}
            >
              {sourceOpen ? "Hide linked files" : "Import linked files"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">Supported: PDF, Word, Excel, CSV, text, Markdown, PNG, JPEG, and WebP.</p>

          {actionError ? <Callout tone="error" role="alert">{actionError}</Callout> : null}
          {savedAttachments.error ? (
            <Callout tone="error" role="alert" action={<Button type="button" size="sm" variant="outline" onClick={() => void loadSavedAttachments()}>Retry</Button>}>
              {savedAttachments.error}
            </Callout>
          ) : savedAttachments.loading ? (
            <div role="status" className="flex items-center gap-2 rounded-md border border-dashed border-border bg-background px-3 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Loading attachments…
            </div>
          ) : savedAttachments.data.length ? (
            <ul className="space-y-2" aria-label="Saved story attachments">
              {savedAttachments.data.map((attachment) => {
                const selectable = isSelectableAttachment(attachment);
                const selected = selectedAttachmentIds.includes(attachment.id);
                const deleting = busyAction === `delete:${attachment.id}`;
                const retrying = busyAction === `retry:${attachment.id}`;
                return (
                  <li key={attachment.id} className={cn("flex flex-col gap-2 rounded-md border bg-background p-3 sm:flex-row sm:items-center sm:justify-between", selected && "border-primary/40 bg-primary/[0.03]")}>
                    <label className={cn("flex min-w-0 flex-1 items-start gap-2.5", selectable ? "cursor-pointer" : "cursor-not-allowed") }>
                      <Checkbox
                        checked={selected}
                        disabled={!selectable || deleting || retrying}
                        aria-label={`Include ${attachment.originalFileName} in this run`}
                        onCheckedChange={(value) => toggleSelection(attachment, value === true)}
                      />
                      <span className="min-w-0 space-y-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{attachment.originalFileName}</span>
                          <AttachmentStatusBadge status={attachment.parseStatus} />
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {sourceKindLabel(attachment.source.kind)}{attachment.mimeType ? ` · ${attachment.mimeType}` : ""}{attachment.byteSize !== null ? ` · ${formatFileSize(attachment.byteSize)}` : ""}
                        </span>
                        {attachment.parseStatus === "partially_parsed" && attachment.parseWarnings.length ? (
                          <span className="block text-xs text-warning-foreground dark:text-warning">{attachment.parseWarnings[0]}</span>
                        ) : null}
                        {attachment.parseStatus === "parse_failed" && attachment.parseError ? (
                          <span className="block text-xs text-destructive">{attachment.parseError}</span>
                        ) : null}
                        {!selectable && attachment.parseStatus !== "parse_failed" ? (
                          <span className="block text-xs text-muted-foreground">This file will be available when processing finishes.</span>
                        ) : null}
                      </span>
                    </label>
                    <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                      {attachment.parseStatus === "parse_failed" ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => void retryAttachment(attachment.id)} disabled={Boolean(busyAction)}>
                          {retrying ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-3.5" />}
                          Retry
                        </Button>
                      ) : null}
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${attachment.originalFileName}`} title="Remove saved copy" onClick={() => setDeleteTarget(attachment)} disabled={Boolean(busyAction)}>
                        {deleting ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Trash2 className="size-3.5 text-destructive" />}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="rounded-md border border-dashed border-border bg-background px-3 py-4 text-sm text-muted-foreground">
              No saved attachments for this work item yet.
            </div>
          )}

          {sourceOpen ? (
            <div className="space-y-2 rounded-md border border-border bg-background p-3">
              <div>
                <h4 className="text-sm font-medium text-foreground">Files already linked to this work item</h4>
                <p className="mt-1 text-xs text-muted-foreground">Importing creates a private iTestFlow copy for this story. It does not change Jira or Azure DevOps.</p>
              </div>
              {sourceAttachments.error ? (
                <Callout tone="error" role="alert" action={<Button type="button" size="sm" variant="outline" onClick={() => void loadSourceAttachments()}>Retry</Button>}>
                  {sourceAttachments.error}
                </Callout>
              ) : sourceAttachments.loading ? (
                <div role="status" className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Loading linked files…</div>
              ) : sourceAttachments.data.length ? (
                <ul className="space-y-2" aria-label="Linked work item attachments">
                  {sourceAttachments.data.map((attachment) => {
                    const importing = busyAction === `import:${attachment.id}`;
                    return (
                      <li key={attachment.id} className="flex flex-col gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-foreground">{attachment.fileName}</span>
                          <span className="block text-xs text-muted-foreground">{attachment.contentType ?? "Unknown type"}{attachment.size !== null ? ` · ${formatFileSize(attachment.size)}` : ""}</span>
                        </span>
                        <Button type="button" size="sm" variant="outline" onClick={() => void importSourceAttachment(attachment.id)} disabled={Boolean(busyAction)}>
                          {importing ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
                          {importing ? "Importing…" : "Import"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No linked files are available to import.</p>
              )}
            </div>
          ) : null}
        </>
      )}

      <p aria-live="polite" className="sr-only">
        {selectedAttachmentIds.length} attachment{selectedAttachmentIds.length === 1 ? "" : "s"} selected for this run.
      </p>

      <ConfirmationDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !busyAction) setDeleteTarget(null);
        }}
        title="Remove saved attachment?"
        description={<span><strong>{deleteTarget?.originalFileName}</strong> will be removed from iTestFlow and no longer available as AI context for this story.</span>}
        confirmLabel={busyAction ? "Removing…" : "Remove saved copy"}
        onConfirm={() => void deleteAttachment()}
      />
    </section>
  );
}

function isSelectableAttachment(attachment: StoryAttachment) {
  return attachment.parseStatus === "parsed" || attachment.parseStatus === "partially_parsed";
}

function isProcessingAttachment(attachment: StoryAttachment) {
  return attachment.parseStatus === "pending" || attachment.parseStatus === "parsing";
}

function AttachmentStatusBadge({ status }: { status: string }) {
  const label = {
    pending: "Queued",
    parsing: "Processing",
    parsed: "Ready",
    partially_parsed: "Ready with warnings",
    parse_failed: "Failed",
  }[status] ?? status.replace(/_/g, " ");
  const className = status === "parsed"
    ? "border-success/30 bg-success/10 text-success"
    : status === "partially_parsed"
      ? "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning"
      : status === "parse_failed"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "border-primary/30 bg-primary/10 text-primary";
  return <Badge variant="outline" className={className}>{label}</Badge>;
}

function sourceKindLabel(kind: string) {
  if (kind === "azure_devops_attachment") return "Azure DevOps attachment";
  if (kind === "jira_attachment") return "Jira attachment";
  return "Uploaded file";
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function storyAttachmentUrl(path: string, scope: ActiveProjectScope, workItemId: string) {
  const params = new URLSearchParams({ scope: JSON.stringify(scope), workItemId });
  return `${path}?${params.toString()}`;
}

function storyAttachmentContextKey(scope: ActiveProjectScope | null, workItemId: string) {
  return scope && workItemId ? `${scope.workspaceId ?? ""}:${scope.projectId}:${workItemId}` : null;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  return readJsonResponse<T>(response);
}

async function deleteJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return readJsonResponse<T>(response);
}

function attachmentList(value: unknown): StoryAttachment[] {
  const record = asRecord(value);
  return Array.isArray(record?.attachments)
    ? record.attachments.map(normalizeStoryAttachment).filter((attachment): attachment is StoryAttachment => attachment !== null)
    : [];
}

function normalizeStoryAttachment(value: unknown): StoryAttachment | null {
  const record = asRecord(value);
  const id = textValue(record?.id);
  if (!id) return null;
  const source = asRecord(record?.source);
  const sourceKind = textValue(source?.kind ?? record?.sourceKind) ?? "upload";
  return {
    id,
    originalFileName: textValue(record?.originalFileName ?? record?.fileName) ?? "Unnamed attachment",
    mimeType: textValue(record?.mimeType ?? record?.contentType),
    byteSize: numberValue(record?.byteSize ?? record?.size),
    parseStatus: textValue(record?.parseStatus) ?? "pending",
    parseWarnings: stringArray(record?.parseWarnings),
    parseError: textValue(record?.parseError),
    source: { kind: sourceKind },
  };
}

function sourceAttachmentList(value: unknown): SourceAttachment[] {
  const record = asRecord(value);
  return Array.isArray(record?.attachments)
    ? record.attachments.map(normalizeSourceAttachment).filter((attachment): attachment is SourceAttachment => attachment !== null)
    : [];
}

function normalizeSourceAttachment(value: unknown): SourceAttachment | null {
  const record = asRecord(value);
  const id = textValue(record?.id);
  const fileName = textValue(record?.fileName ?? record?.originalFileName);
  if (!id || !fileName) return null;
  return {
    id,
    fileName,
    contentType: textValue(record?.contentType ?? record?.mimeType),
    size: numberValue(record?.size ?? record?.byteSize),
    createdAt: textValue(record?.createdAt),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function uploadFailures(value: StoryAttachmentUploadResponse): Array<{ fileName: string | null }> {
  if (!Array.isArray(value?.failures)) return [];
  return value.failures
    .map((failure) => asRecord(failure))
    .filter((failure): failure is Record<string, unknown> => failure !== null)
    .map((failure) => ({ fileName: textValue(failure.fileName) }));
}

function uploadFailureMessage(failures: Array<{ fileName: string | null }>) {
  const names = failures
    .map((failure) => failure.fileName)
    .filter((name): name is string => Boolean(name))
    .slice(0, 3);
  const count = failures.length;
  const fileLabel = count === 1 ? "file" : "files";
  const named = names.length ? `: ${names.join(", ")}${count > names.length ? ", …" : ""}` : "";
  return `${count} ${fileLabel} could not be added${named}. Check the format and size, then try again.`;
}

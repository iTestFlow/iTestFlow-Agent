"use client"

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import {
  Archive,
  Download,
  FileText,
  FileUp,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { ConfirmationDialog } from "@/components/qa/confirmation-dialog"
import { DataToolbar } from "@/components/qa/data-toolbar"
import { EmptyState } from "@/components/qa/empty-state"
import { ErrorState } from "@/components/qa/error-state"
import { StatusChip } from "@/components/qa/status-chip"
import { patchJson, postForm, postJson } from "@/components/workflow/post-json"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { ActiveProjectScope } from "@/shared/lib/active-project"

export const DOCUMENT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export const DOCUMENT_UPLOAD_EXTENSIONS = ["pdf", "docx", "xlsx", "csv", "txt", "md"] as const
export const DOCUMENT_UPLOAD_ACCEPT = ".pdf,.docx,.xlsx,.csv,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,text/markdown"

type DocumentLifecycleStatus = "active" | "archived" | string
type DocumentParseStatus = "pending" | "parsing" | "parsed" | "partially_parsed" | "parse_failed" | string

export type SourceDocumentVersion = {
  id: string
  documentId?: string
  versionNumber: number
  originalFileName: string
  mimeType?: string | null
  fileFormat?: string | null
  byteSize: number
  parseStatus: DocumentParseStatus
  parseError?: string | null
  parseWarnings: string[]
  parseRecipeVersion?: string | null
  chunkCount: number
  uploadedBy?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type SourceDocument = {
  id: string
  documentName: string
  description?: string | null
  tags: string[]
  languageHint?: string | null
  documentKind?: string | null
  sourceConnector?: string | null
  currentVersionId?: string | null
  lifecycleStatus: DocumentLifecycleStatus
  archivedAt?: string | null
  archivedReason?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type SourceDocumentChunk = {
  id: string
  section?: string | null
  pageNumber?: number | null
  chunkIndex: number
  content: string
  createdAt?: string | null
}

export type DocumentIngestJob = {
  id: string
  status: string
  versionId?: string | null
  phase?: string | null
  progress?: {
    percent?: number | null
    completed?: number | null
    total?: number | null
  } | null
  error?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type DocumentListItem = {
  document: SourceDocument
  currentVersion: SourceDocumentVersion | null
  versionCount: number
  job?: DocumentIngestJob | null
}

export type DocumentUploadAcceptance = {
  document: SourceDocument
  version: SourceDocumentVersion
  job: DocumentIngestJob | null
}

type DocumentDetail = {
  document: SourceDocument
  versions: SourceDocumentVersion[]
  chunks: SourceDocumentChunk[]
}

type DocumentImpact = {
  entryCount: number
  entries: Array<{ id: string; title: string; category?: string | null; status?: string | null }>
}

type UploadRow = {
  key: string
  file: File
  error?: string
  state: "ready" | "uploading" | "queued"
  versionId?: string
  jobId?: string
}

type UploadMetadata = {
  title: string
  description: string
  tags: string
  languageHint: string
}

type EditableDocumentMetadata = {
  documentName: string
  description: string | null
  tags: string[]
  languageHint: string | null
}

const EMPTY_UPLOAD_METADATA: UploadMetadata = {
  title: "",
  description: "",
  tags: "",
  languageHint: "",
}

const ACTIVE_PARSE_STATUSES = new Set(["pending", "parsing"])
const ACTIVE_JOB_STATUSES = new Set(["pending", "running"])

export function DocumentsPanel({
  scope,
  canManage,
  onCountChange,
}: {
  scope: ActiveProjectScope | null
  canManage: boolean
  onCountChange?: (count: number) => void
}) {
  const [documents, setDocuments] = useState<DocumentListItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [lifecycleStatus, setLifecycleStatus] = useState<"all" | "active" | "archived">("active")
  const [parseStatus, setParseStatus] = useState<"all" | "pending" | "parsing" | "parsed" | "partially_parsed" | "parse_failed">("all")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<SourceDocument | null>(null)
  const [archiveImpact, setArchiveImpact] = useState<DocumentImpact | null>(null)
  const [archiveImpactLoading, setArchiveImpactLoading] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [trackedJobs, setTrackedJobs] = useState<Record<string, DocumentIngestJob>>({})
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden")
  const listRequestId = useRef(0)
  const detailRequestId = useRef(0)
  const pollFailureCountRef = useRef(0)
  const announcedTerminalJobsRef = useRef(new Set<string>())

  const scopeKey = scope ? `${scope.workspaceId ?? "workspace"}:${scope.projectId}:${scope.azureProjectId}` : ""
  const activeTrackedJobs = useMemo(
    () => Object.values(trackedJobs).filter((job) => ACTIVE_JOB_STATUSES.has(job.status)),
    [trackedJobs],
  )
  const hasInProgressDocument = documents.some((item) => isDocumentProcessing(item))
  // Session-local trackedJobs is empty on a cold page load, so a document the server
  // already reports as processing has no job to derive age from. This fallback keeps
  // the backoff tiers engaging instead of recomputing age as 0 on every tick.
  const newestInProgressVersionCreatedAt = useMemo(
    () => newestInProgressVersionTimestamp(documents),
    [documents],
  )

  const refreshDocuments = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!scope) {
      setDocuments([])
      setTotalCount(0)
      onCountChange?.(0)
      return
    }
    const requestId = ++listRequestId.current
    if (!silent) setLoading(true)
    setError(null)
    try {
      const response = await getJson<unknown>(documentListUrl(scope, {
        page: 1,
        pageSize: 100,
        lifecycleStatus: lifecycleStatus === "all" ? undefined : lifecycleStatus,
        search,
      }))
      if (requestId !== listRequestId.current) return
      const normalized = normalizeDocumentListResponse(response)
      const items = parseStatus === "all"
        ? normalized.items
        : normalized.items.filter((item) => item.currentVersion?.parseStatus === parseStatus)
      const count = parseStatus === "all" ? normalized.totalCount : items.length
      setDocuments(items)
      setTotalCount(count)
      onCountChange?.(count)
    } catch (loadError) {
      if (requestId !== listRequestId.current) return
      setDocuments([])
      setTotalCount(0)
      onCountChange?.(0)
      setError(errorMessage(loadError, "Documents could not be loaded."))
    } finally {
      if (requestId === listRequestId.current && !silent) setLoading(false)
    }
  }, [lifecycleStatus, onCountChange, parseStatus, scope, search])

  const loadDetail = useCallback(async (documentId: string, activeScope: ActiveProjectScope | null = scope) => {
    if (!activeScope) return
    const requestId = ++detailRequestId.current
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await getJson<unknown>(documentDetailUrl(documentId, activeScope))
      if (requestId !== detailRequestId.current) return
      setDetail(normalizeDocumentDetailResponse(response))
    } catch (loadError) {
      if (requestId !== detailRequestId.current) return
      setDetail(null)
      setDetailError(errorMessage(loadError, "Document details could not be loaded."))
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false)
    }
  }, [scope])

  useEffect(() => {
    if (!scope) {
      listRequestId.current += 1
      setDocuments([])
      setTotalCount(0)
      setTrackedJobs({})
      setError(null)
      onCountChange?.(0)
      return
    }
    const timeout = window.setTimeout(() => {
      void refreshDocuments()
    }, search.trim() ? 250 : 0)
    return () => window.clearTimeout(timeout)
  }, [lifecycleStatus, onCountChange, parseStatus, refreshDocuments, scope, scopeKey, search])

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [])

  useEffect(() => {
    if (!scope || !pageVisible || (!hasInProgressDocument && !activeTrackedJobs.length)) return
    const trackedCreatedAt = activeTrackedJobs
      .map((job) => job.createdAt)
      .find((createdAt): createdAt is string => Boolean(createdAt))
    const referenceCreatedAt = trackedCreatedAt ?? newestInProgressVersionCreatedAt
    const timeout = window.setTimeout(() => {
      void Promise.all(activeTrackedJobs.map((job) => readDocumentJob(job.id, scope)))
        .then((nextJobs) => {
          pollFailureCountRef.current = 0
          setTrackedJobs((current) => {
            const next = { ...current }
            for (const job of nextJobs.filter((candidate): candidate is DocumentIngestJob => Boolean(candidate))) {
              next[job.id] = job
              if (!ACTIVE_JOB_STATUSES.has(job.status) && !announcedTerminalJobsRef.current.has(job.id)) {
                announcedTerminalJobsRef.current.add(job.id)
                if (job.status === "completed") toast.success("Document processing completed.")
                if (job.status === "failed") toast.error(job.error ?? "Document processing failed.")
              }
            }
            return next
          })
          void refreshDocuments({ silent: true })
          if (selectedDocumentId) void loadDetail(selectedDocumentId)
        })
        .catch(() => {
          pollFailureCountRef.current += 1
        })
    }, documentPollDelay(referenceCreatedAt, pollFailureCountRef.current, Date.now()))
    return () => window.clearTimeout(timeout)
  }, [activeTrackedJobs, hasInProgressDocument, loadDetail, newestInProgressVersionCreatedAt, pageVisible, refreshDocuments, scope, selectedDocumentId])

  useEffect(() => {
    if (!selectedDocumentId) {
      detailRequestId.current += 1
      setDetail(null)
      setDetailError(null)
      return
    }
    void loadDetail(selectedDocumentId)
  }, [loadDetail, selectedDocumentId])

  const jobsByVersionId = useMemo(() => {
    const entries = Object.values(trackedJobs)
      .filter((job): job is DocumentIngestJob & { versionId: string } => Boolean(job.versionId))
      .map((job) => [job.versionId, job] as const)
    return Object.fromEntries(entries)
  }, [trackedJobs])

  const acceptUploads = useCallback((uploads: DocumentUploadAcceptance[]) => {
    setTrackedJobs((current) => {
      const next = { ...current }
      for (const upload of uploads) {
        if (upload.job) next[upload.job.id] = upload.job
      }
      return next
    })
    void refreshDocuments({ silent: true })
  }, [refreshDocuments])

  const archiveDocument = useCallback(async () => {
    if (!scope || !archiveTarget) return
    setArchiveBusy(true)
    try {
      await postJson(`/api/context/documents/${encodeURIComponent(archiveTarget.id)}/archive`, { scope })
      toast.success("Document archived. It is no longer used for retrieval.")
      setArchiveTarget(null)
      setArchiveImpact(null)
      setSelectedDocumentId(null)
      await refreshDocuments({ silent: true })
    } catch (archiveError) {
      toast.error(errorMessage(archiveError, "The document could not be archived."))
    } finally {
      setArchiveBusy(false)
    }
  }, [archiveTarget, refreshDocuments, scope])

  const requestArchive = useCallback((sourceDocument: SourceDocument) => {
    if (!scope) return
    setArchiveTarget(sourceDocument)
    setArchiveImpact(null)
    setArchiveImpactLoading(true)
    void getJson<unknown>(documentImpactUrl(sourceDocument.id, scope))
      .then((response) => setArchiveImpact(normalizeDocumentImpactResponse(response)))
      .catch(() => {
        // The impact endpoint is additive (and arrives with compiler support). A
        // temporary failure must not prevent archive-first lifecycle handling.
      })
      .finally(() => setArchiveImpactLoading(false))
  }, [scope])

  const restoreDocument = useCallback(async (sourceDocument: SourceDocument) => {
    if (!scope) return
    try {
      await postJson(`/api/context/documents/${encodeURIComponent(sourceDocument.id)}/restore`, { scope })
      toast.success("Document restored to retrieval.")
      await Promise.all([
        refreshDocuments({ silent: true }),
        selectedDocumentId === sourceDocument.id ? loadDetail(sourceDocument.id) : Promise.resolve(),
      ])
    } catch (restoreError) {
      toast.error(errorMessage(restoreError, "The document could not be restored."))
    }
  }, [loadDetail, refreshDocuments, scope, selectedDocumentId])

  const reprocessDocument = useCallback(async (sourceDocument: SourceDocument) => {
    if (!scope) return
    try {
      const response = await postJson<unknown>(`/api/context/documents/${encodeURIComponent(sourceDocument.id)}/reprocess`, { scope })
      const acceptance = normalizeDocumentReprocessResponse(response)
      if (acceptance) {
        acceptUploads([acceptance])
      } else {
        await refreshDocuments({ silent: true })
      }
      if (selectedDocumentId === sourceDocument.id) await loadDetail(sourceDocument.id)
      toast.success("Document queued for reprocessing.")
    } catch (reprocessError) {
      toast.error(errorMessage(reprocessError, "The document could not be queued for reprocessing."))
    }
  }, [acceptUploads, loadDetail, refreshDocuments, scope, selectedDocumentId])

  const updateDocumentMetadata = useCallback(async (
    documentId: string,
    metadata: EditableDocumentMetadata,
  ) => {
    if (!scope) return
    await patchJson(`/api/context/documents/${encodeURIComponent(documentId)}`, {
      scope,
      ...metadata,
    })
    toast.success("Document metadata updated.")
    await Promise.all([
      refreshDocuments({ silent: true }),
      selectedDocumentId === documentId ? loadDetail(documentId) : Promise.resolve(),
    ])
  }, [loadDetail, refreshDocuments, scope, selectedDocumentId])

  if (!scope) {
    return (
      <EmptyState
        title="Select a project to view documents"
        description="Uploaded documents are scoped to the active Azure DevOps project."
        icon={FolderOpen}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Project documents</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "Upload text documents to make them available as project context after processing."
              : "Documents used as project context. Ask a workspace owner or admin to manage documents from the Build Knowledge tab."}
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <FileUp className="size-4" aria-hidden="true" />
            Upload documents
          </Button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <DataToolbar
          searchPlaceholder="Search documents"
          searchValue={search}
          onSearchChange={setSearch}
          filters={(
            <>
              <Select value={lifecycleStatus} onValueChange={(value) => setLifecycleStatus(value as typeof lifecycleStatus)}>
                <SelectTrigger size="sm" aria-label="Filter document lifecycle"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                  <SelectItem value="all">All lifecycle states</SelectItem>
                </SelectContent>
              </Select>
              <Select value={parseStatus} onValueChange={(value) => setParseStatus(value as typeof parseStatus)}>
                <SelectTrigger size="sm" aria-label="Filter document processing status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All processing states</SelectItem>
                  <SelectItem value="pending">Queued</SelectItem>
                  <SelectItem value="parsing">Processing</SelectItem>
                  <SelectItem value="parsed">Ready</SelectItem>
                  <SelectItem value="partially_parsed">Ready with warnings</SelectItem>
                  <SelectItem value="parse_failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
          actions={(
            <Button size="sm" variant="outline" onClick={() => void refreshDocuments()} disabled={loading}>
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
              Refresh
            </Button>
          )}
        />

        {error ? (
          <div className="p-4"><ErrorState title="Could not load documents" message={error} onRetry={() => void refreshDocuments()} /></div>
        ) : loading ? (
          <DocumentTableSkeleton />
        ) : documents.length ? (
          <DocumentTable
            documents={documents}
            jobsByVersionId={jobsByVersionId}
            scope={scope}
            canManage={canManage}
            onDetail={setSelectedDocumentId}
            onArchive={requestArchive}
            onRestore={restoreDocument}
          />
        ) : (
          <div className="p-4">
            <EmptyState
              title={search || lifecycleStatus !== "active" || parseStatus !== "all" ? "No documents match these filters" : "No project documents yet"}
              description={canManage
                ? "Upload a PDF, Word document, spreadsheet, CSV, text file, or Markdown file to add it to this project’s context."
                : "No documents have been uploaded to this project yet. Ask a workspace owner or admin to manage documents from the Build Knowledge tab."}
              actionLabel={canManage ? "Upload your first document" : undefined}
              onAction={canManage ? () => setUploadOpen(true) : undefined}
              icon={FileText}
            />
          </div>
        )}
      </div>

      <p aria-live="polite" className="text-xs text-muted-foreground">
        {totalCount} document{totalCount === 1 ? "" : "s"} in this view.
      </p>

      <DocumentUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        scope={scope}
        jobsByVersionId={jobsByVersionId}
        onAccepted={acceptUploads}
      />

      <DocumentDetailSheet
        open={Boolean(selectedDocumentId)}
        onOpenChange={(open) => { if (!open) setSelectedDocumentId(null) }}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        scope={scope}
        canManage={canManage}
        jobsByVersionId={jobsByVersionId}
        onRetry={() => selectedDocumentId && void loadDetail(selectedDocumentId)}
        onAccepted={acceptUploads}
        onArchive={requestArchive}
        onRestore={restoreDocument}
        onReprocess={reprocessDocument}
        onUpdateMetadata={updateDocumentMetadata}
      />

      <ConfirmationDialog
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => {
          if (!open && !archiveBusy) {
            setArchiveTarget(null)
            setArchiveImpact(null)
          }
        }}
        title="Archive this document?"
        description={(
          <div className="space-y-2">
            <p><span className="font-medium text-foreground">{archiveTarget?.documentName}</span> will be excluded from retrieval immediately.</p>
            {archiveImpactLoading ? <p>Checking published knowledge that cites this source…</p> : null}
            {archiveImpact ? (
              archiveImpact.entryCount ? (
                <>
                  <p>{archiveImpact.entryCount} published knowledge entr{archiveImpact.entryCount === 1 ? "y cites" : "ies cite"} this document. Existing reviewed knowledge is preserved, but may need a refresh.</p>
                  <DocumentImpactEntryList entries={archiveImpact.entries.slice(0, 3)} />
                </>
              ) : <p>No published knowledge entries currently cite this document.</p>
            ) : <p>Existing reviewed knowledge is preserved, but may need a refresh if it relies on this source.</p>}
          </div>
        )}
        confirmLabel={archiveBusy ? "Archiving…" : "Archive document"}
        onConfirm={() => void archiveDocument()}
      />
    </div>
  )
}

export function DocumentUploadDialog({
  open,
  onOpenChange,
  scope,
  onAccepted,
  jobsByVersionId = {},
  replaceDocumentId,
  documentLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: ActiveProjectScope
  onAccepted: (uploads: DocumentUploadAcceptance[]) => void
  jobsByVersionId?: Record<string, DocumentIngestJob>
  replaceDocumentId?: string
  documentLabel?: string
}) {
  const inputId = useId()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const rowIdRef = useRef(0)
  const [rows, setRows] = useState<UploadRow[]>([])
  const [metadata, setMetadata] = useState<UploadMetadata>(EMPTY_UPLOAD_METADATA)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (open) return
    setRows([])
    setMetadata(EMPTY_UPLOAD_METADATA)
    setSubmitError(null)
    setSubmitting(false)
  }, [open])

  const validRows = rows.filter((row) => !row.error)
  const readyRows = validRows.filter((row) => row.state === "ready")
  const acceptsOnlyOneFile = Boolean(replaceDocumentId)
  const acceptedFileCount = validRows.filter((row) => row.state === "queued").length

  function addFiles(nextFiles: File[]) {
    if (!nextFiles.length) return
    setSubmitError(null)
    setRows((current) => {
      const existing = new Set(current.map((row) => fileIdentity(row.file)))
      const additions = nextFiles.map((file) => {
        rowIdRef.current += 1
        const duplicate = existing.has(fileIdentity(file))
        existing.add(fileIdentity(file))
        return {
          key: `document-upload-${rowIdRef.current}`,
          file,
          state: "ready" as const,
          error: duplicate ? "This file is already selected." : validateDocumentUploadFile(file),
        }
      })
      return acceptsOnlyOneFile ? [...current, ...additions].slice(-1) : [...current, ...additions]
    })
  }

  function removeFile(key: string) {
    setRows((current) => current.filter((row) => row.key !== key))
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!readyRows.length) {
      setSubmitError("Choose at least one supported file before uploading.")
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    setRows((current) => current.map((row) => row.error ? row : { ...row, state: "uploading" }))
    try {
      const formData = buildDocumentUploadFormData(scope, metadata, readyRows.map((row) => row.file))
      const endpoint = replaceDocumentId
        ? `/api/context/documents/${encodeURIComponent(replaceDocumentId)}/versions`
        : "/api/context/documents/upload"
      const response = await postForm<unknown>(endpoint, formData)
      const uploads = normalizeDocumentUploadResponse(response)
      if (!uploads.length) throw new Error("The server accepted the upload without returning a document record.")
      let uploadIndex = 0
      setRows((current) => current.map((row) => {
        if (row.error || row.state !== "uploading") return row
        const upload = uploads[uploadIndex]
        uploadIndex += 1
        return upload
          ? { ...row, state: "queued", versionId: upload.version.id, jobId: upload.job?.id }
          : { ...row, state: "ready", error: "The server did not accept this file." }
      }))
      onAccepted(uploads)
      toast.success(`${uploads.length} document${uploads.length === 1 ? "" : "s"} queued for processing.`)
    } catch (uploadError) {
      const message = errorMessage(uploadError, "The documents could not be uploaded.")
      setSubmitError(message)
      setRows((current) => current.map((row) => row.state === "uploading" ? { ...row, state: "ready" } : row))
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] overflow-y-auto sm:max-w-2xl" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>{replaceDocumentId ? "Replace document version" : "Upload documents"}</DialogTitle>
          <DialogDescription>
            {replaceDocumentId
              ? `Upload one replacement file for ${documentLabel ?? "this document"}. Earlier versions stay available for provenance.`
              : "Files are processed in the background, then become available as project context."}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={submit}>
          {!replaceDocumentId ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${inputId}-title`}>Title <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  id={`${inputId}-title`}
                  value={metadata.title}
                  onChange={(event) => setMetadata((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Use the file name by default"
                />
                <p className="text-xs text-muted-foreground">A title applies when uploading a single file.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${inputId}-language`}>Language hint <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  id={`${inputId}-language`}
                  value={metadata.languageHint}
                  onChange={(event) => setMetadata((current) => ({ ...current, languageHint: event.target.value }))}
                  placeholder="e.g. English or Arabic"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`${inputId}-description`}>Description <span className="text-muted-foreground">(optional)</span></Label>
                <Textarea
                  id={`${inputId}-description`}
                  value={metadata.description}
                  onChange={(event) => setMetadata((current) => ({ ...current, description: event.target.value }))}
                  placeholder="What should collaborators know about this document?"
                  className="min-h-20 resize-y"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`${inputId}-tags`}>Tags <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  id={`${inputId}-tags`}
                  value={metadata.tags}
                  onChange={(event) => setMetadata((current) => ({ ...current, tags: event.target.value }))}
                  placeholder="Comma-separated, e.g. onboarding, finance"
                />
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <div
              role="button"
              tabIndex={0}
              aria-label={acceptsOnlyOneFile ? "Choose a replacement document" : "Add documents to upload"}
              aria-describedby={`${inputId}-help`}
              className={`rounded-lg border border-dashed p-5 text-center outline-none transition motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                dragging ? "border-primary bg-primary/5" : "border-input bg-muted/15 hover:border-primary/60"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                fileInputRef.current?.click()
              }}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = "copy"
              }}
              onDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                setDragging(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                addFiles(Array.from(event.dataTransfer.files))
              }}
            >
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-background ring-1 ring-border">
                <FileUp className="size-5 text-muted-foreground" aria-hidden="true" />
              </div>
              <Label
                htmlFor={inputId}
                className="mt-3 block cursor-pointer text-sm font-medium text-foreground"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  fileInputRef.current?.click()
                }}
              >
                Drop files here or choose files
              </Label>
              <p id={`${inputId}-help`} className="mt-1 text-xs text-muted-foreground">
                PDF, DOCX, XLSX, CSV, TXT, or Markdown. Up to {formatFileSize(DOCUMENT_UPLOAD_MAX_BYTES)} per file.
              </p>
              <input
                ref={fileInputRef}
                id={inputId}
                type="file"
                tabIndex={-1}
                className="sr-only"
                accept={DOCUMENT_UPLOAD_ACCEPT}
                multiple={!acceptsOnlyOneFile}
                aria-label={acceptsOnlyOneFile ? "Select replacement document" : "Select documents to upload"}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []))
                  event.target.value = ""
                }}
              />
            </div>
          </div>

          {rows.length ? (
            <div className="space-y-2" aria-live="polite">
              {rows.map((row) => {
                const job = row.versionId ? jobsByVersionId[row.versionId] : undefined
                const progress = job?.progress?.percent
                return (
                  <div key={row.key} className="rounded-lg border border-border bg-background px-3 py-2.5">
                    <div className="flex items-start gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{row.file.name}</p>
                        <p className="text-xs text-muted-foreground">{formatFileSize(row.file.size)}{row.file.type ? ` · ${row.file.type}` : ""}</p>
                        {row.error ? <p role="alert" className="mt-1 text-xs text-destructive">{row.error}</p> : null}
                        {!row.error && row.state === "uploading" ? <p className="mt-1 text-xs text-muted-foreground">Uploading…</p> : null}
                        {!row.error && row.state === "queued" ? (
                          <div className="mt-2 space-y-1.5">
                            <p className="text-xs text-muted-foreground">{documentJobLabel(job) ?? "Queued for processing"}</p>
                            {typeof progress === "number" ? <Progress value={progress} aria-label={`${row.file.name}: ${progress}% processed`} /> : null}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${row.file.name}`}
                        onClick={() => removeFile(row.key)}
                        disabled={submitting || row.state === "queued"}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}

          {submitError ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{submitError}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {acceptedFileCount ? "Done" : "Cancel"}
            </Button>
            <Button type="submit" disabled={submitting || !readyRows.length}>
              {submitting ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FileUp className="size-4" aria-hidden="true" />}
              {submitting ? "Uploading…" : replaceDocumentId ? "Upload replacement" : "Upload documents"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DocumentTable({
  documents,
  jobsByVersionId,
  scope,
  canManage,
  onDetail,
  onArchive,
  onRestore,
}: {
  documents: DocumentListItem[]
  jobsByVersionId: Record<string, DocumentIngestJob>
  scope: ActiveProjectScope
  canManage: boolean
  onDetail: (documentId: string) => void
  onArchive: (sourceDocument: SourceDocument) => void
  onRestore: (sourceDocument: SourceDocument) => void
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead>Processing</TableHead>
            <TableHead className="hidden md:table-cell">Uploaded</TableHead>
            <TableHead className="hidden lg:table-cell">Versions</TableHead>
            <TableHead className="hidden lg:table-cell">Chunks</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((item) => {
            const currentVersion = item.currentVersion
            const job = currentVersion ? jobsByVersionId[currentVersion.id] ?? item.job : item.job
            const isArchived = item.document.lifecycleStatus === "archived"
            return (
              <TableRow key={item.document.id} className={isArchived ? "bg-muted/20" : undefined}>
                <TableCell className="min-w-52">
                  <button
                    type="button"
                    className="text-left font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onClick={() => onDetail(item.document.id)}
                  >
                    {item.document.documentName}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {isArchived ? <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning-foreground dark:text-warning">Archived</Badge> : null}
                    {item.document.tags.slice(0, 3).map((tag) => <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>)}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{currentVersion?.originalFileName ?? "No version available"}</p>
                </TableCell>
                <TableCell>
                  <DocumentProcessingStatus version={currentVersion} job={job} archived={isArchived} />
                </TableCell>
                <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                  <div>{currentVersion?.uploadedBy ?? "—"}</div>
                  <div className="text-xs">{formatDate(currentVersion?.createdAt ?? item.document.createdAt)}</div>
                </TableCell>
                <TableCell className="hidden tabular-nums lg:table-cell">{item.versionCount}</TableCell>
                <TableCell className="hidden tabular-nums lg:table-cell">{currentVersion?.chunkCount ?? 0}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => onDetail(item.document.id)}>Details</Button>
                    {currentVersion ? (
                      <Button size="icon-sm" variant="ghost" asChild>
                        <a href={documentDownloadUrl(currentVersion.id, scope)} aria-label={`Download ${item.document.documentName}`}>
                          <Download className="size-4" aria-hidden="true" />
                        </a>
                      </Button>
                    ) : null}
                    {canManage && !isArchived ? (
                      <Button size="icon-sm" variant="ghost" onClick={() => onArchive(item.document)} aria-label={`Archive ${item.document.documentName}`}>
                        <Archive className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                    {canManage && isArchived ? (
                      <Button size="icon-sm" variant="ghost" onClick={() => void onRestore(item.document)} aria-label={`Restore ${item.document.documentName}`}>
                        <RotateCcw className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function DocumentDetailSheet({
  open,
  onOpenChange,
  detail,
  loading,
  error,
  scope,
  canManage,
  jobsByVersionId,
  onRetry,
  onAccepted,
  onArchive,
  onRestore,
  onReprocess,
  onUpdateMetadata,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: DocumentDetail | null
  loading: boolean
  error: string | null
  scope: ActiveProjectScope
  canManage: boolean
  jobsByVersionId: Record<string, DocumentIngestJob>
  onRetry: () => void
  onAccepted: (uploads: DocumentUploadAcceptance[]) => void
  onArchive: (document: SourceDocument) => void
  onRestore: (document: SourceDocument) => void
  onReprocess: (document: SourceDocument) => void
  onUpdateMetadata: (documentId: string, metadata: EditableDocumentMetadata) => Promise<void>
}) {
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [impact, setImpact] = useState<DocumentImpact | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const latestVersion = detail?.versions.find((version) => version.id === detail.document.currentVersionId) ?? detail?.versions[0] ?? null
  const documentId = detail?.document.id ?? null
  const isArchived = detail?.document.lifecycleStatus === "archived"
  const latestVersionJob = latestVersion ? jobsByVersionId[latestVersion.id] : undefined
  const isProcessing = Boolean(latestVersion && ACTIVE_PARSE_STATUSES.has(latestVersion.parseStatus))
    || Boolean(latestVersionJob && ACTIVE_JOB_STATUSES.has(latestVersionJob.status))

  useEffect(() => {
    if (!open || !documentId) {
      setImpact(null)
      setImpactLoading(false)
      return
    }
    let cancelled = false
    setImpact(null)
    setImpactLoading(true)
    void getJson<unknown>(documentImpactUrl(documentId, scope))
      .then((response) => { if (!cancelled) setImpact(normalizeDocumentImpactResponse(response)) })
      .catch(() => {
        // The impact endpoint is additive (and arrives with compiler support). A
        // temporary failure must not prevent the rest of the detail sheet from working.
      })
      .finally(() => { if (!cancelled) setImpactLoading(false) })
    return () => { cancelled = true }
  }, [documentId, open, scope])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-xl" side="right">
        <SheetHeader className="border-b border-border pr-14">
          <SheetTitle>{detail?.document.documentName ?? "Document details"}</SheetTitle>
          <SheetDescription>Source metadata, processing history, and plain-text extracted context.</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 p-4">
          {loading ? <DocumentDetailSkeleton /> : null}
          {error ? <ErrorState title="Could not load document details" message={error} onRetry={onRetry} /> : null}
          {detail && !loading ? (
            <>
              <div className="space-y-3 rounded-lg border border-border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {detail.document.lifecycleStatus === "archived" ? <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning-foreground dark:text-warning">Archived</Badge> : <Badge variant="outline">Active</Badge>}
                      {latestVersion ? <DocumentProcessingStatus version={latestVersion} job={jobsByVersionId[latestVersion.id]} archived={detail.document.lifecycleStatus === "archived"} /> : null}
                    </div>
                    {detail.document.description ? <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{detail.document.description}</p> : null}
                  </div>
                  {latestVersion ? (
                    <Button size="sm" variant="outline" asChild>
                      <a href={documentDownloadUrl(latestVersion.id, scope)}>
                        <Download className="size-4" aria-hidden="true" />
                        Download
                      </a>
                    </Button>
                  ) : null}
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <DetailValue label="Language" value={detail.document.languageHint} />
                  <DetailValue label="Source" value={detail.document.sourceConnector?.replace(/_/g, " ")} />
                  <DetailValue label="Created" value={formatDate(detail.document.createdAt)} />
                  <DetailValue label="Archived" value={formatDate(detail.document.archivedAt)} />
                </dl>
                {detail.document.tags.length ? <div className="flex flex-wrap gap-1.5">{detail.document.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}</div> : null}
                {canManage ? (
                  <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                    <Button size="sm" variant="outline" onClick={() => setMetadataOpen(true)}>
                      <Pencil className="size-4" aria-hidden="true" />
                      Edit metadata
                    </Button>
                    {detail.document.lifecycleStatus === "archived" ? (
                      <Button size="sm" variant="outline" onClick={() => void onRestore(detail.document)}>
                        <RotateCcw className="size-4" aria-hidden="true" />
                        Restore
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => onArchive(detail.document)}>
                        <Archive className="size-4" aria-hidden="true" />
                        Archive
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => void onReprocess(detail.document)} disabled={isArchived || isProcessing}>
                      <RefreshCw className="size-4" aria-hidden="true" />
                      Reprocess
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setReplaceConfirmOpen(true)} disabled={isArchived}>
                      <FileUp className="size-4" aria-hidden="true" />
                      Replace version
                    </Button>
                  </div>
                ) : null}
              </div>

              <section aria-labelledby="document-impact-title" className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="document-impact-title" className="text-sm font-semibold text-foreground">Knowledge supported by this source</h3>
                  <Badge variant="secondary">{impactLoading ? "…" : `${impact?.entryCount ?? 0} entr${(impact?.entryCount ?? 0) === 1 ? "y" : "ies"}`}</Badge>
                </div>
                {impactLoading ? (
                  <p className="text-sm text-muted-foreground">Checking published knowledge that cites this document…</p>
                ) : impact?.entryCount ? (
                  <div className="rounded-lg border border-border bg-card p-3">
                    <DocumentImpactEntryList entries={impact.entries} />
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">No published knowledge cites this document.</p>
                )}
              </section>

              <section aria-labelledby="document-versions-title" className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 id="document-versions-title" className="text-sm font-semibold text-foreground">Version history</h3>
                  <span className="text-xs text-muted-foreground">{detail.versions.length} version{detail.versions.length === 1 ? "" : "s"}</span>
                </div>
                <div className="space-y-2">
                  {detail.versions.map((version) => (
                    <div key={version.id} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">v{version.versionNumber} · {version.originalFileName}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{formatFileSize(version.byteSize)} · {version.fileFormat?.toUpperCase() ?? "File"} · {formatDate(version.createdAt)}</p>
                        </div>
                        <DocumentProcessingStatus version={version} job={jobsByVersionId[version.id]} archived={false} />
                      </div>
                      {version.parseError ? <p role="alert" className="mt-2 text-xs text-destructive">{version.parseError}</p> : null}
                      {version.parseWarnings.length ? (
                        <ul className="mt-2 space-y-1 rounded-md bg-warning/10 p-2 text-xs text-warning-foreground dark:text-warning">
                          {version.parseWarnings.map((warning, index) => <li key={`${version.id}-${index}`} className="flex gap-1.5"><TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />{warning}</li>)}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>

              <section aria-labelledby="document-content-title" className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 id="document-content-title" className="text-sm font-semibold text-foreground">Extracted content</h3>
                    <p className="mt-1 text-xs text-muted-foreground">Shown as plain text; document markup is never rendered.</p>
                  </div>
                  <Badge variant="secondary">{detail.chunks.length} chunks</Badge>
                </div>
                {detail.chunks.length ? (
                  <div className="space-y-2">
                    {detail.chunks.slice(0, 20).map((chunk) => (
                      <article key={chunk.id} className="rounded-lg border border-border bg-card p-3">
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {chunk.section ? <Badge variant="outline">{chunk.section}</Badge> : null}
                          {chunk.pageNumber ? <Badge variant="outline">Page {chunk.pageNumber}</Badge> : null}
                          <Badge variant="secondary">Chunk {chunk.chunkIndex + 1}</Badge>
                        </div>
                        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-foreground">{chunk.content}</pre>
                      </article>
                    ))}
                    {detail.chunks.length > 20 ? <p className="text-xs text-muted-foreground">Showing the first 20 chunks in this preview.</p> : null}
                  </div>
                ) : <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Parsed text will appear here when processing is complete.</p>}
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>

      {detail && canManage ? (
        <>
          <ConfirmationDialog
            open={replaceConfirmOpen}
            onOpenChange={setReplaceConfirmOpen}
            title="Replace this document version?"
            description={(
              <div className="space-y-2">
                <p>The current version’s chunks leave retrieval as soon as the replacement finishes processing. Knowledge citing <span className="font-medium text-foreground">{detail.document.documentName}</span> will show drift until the next knowledge build.</p>
                {impactLoading ? <p>Checking published knowledge that cites this document…</p> : null}
                {impact ? (
                  impact.entryCount ? (
                    <>
                      <p>{impact.entryCount} published knowledge entr{impact.entryCount === 1 ? "y cites" : "ies cite"} this document.</p>
                      <DocumentImpactEntryList entries={impact.entries.slice(0, 3)} />
                    </>
                  ) : <p>No published knowledge entries currently cite this document.</p>
                ) : null}
              </div>
            )}
            confirmLabel="Continue to replace"
            onConfirm={() => {
              setReplaceConfirmOpen(false)
              setReplaceOpen(true)
            }}
          />
          <DocumentUploadDialog
            open={replaceOpen}
            onOpenChange={setReplaceOpen}
            scope={scope}
            replaceDocumentId={detail.document.id}
            documentLabel={detail.document.documentName}
            onAccepted={(uploads) => {
              onAccepted(uploads)
              setReplaceOpen(false)
              onRetry()
            }}
          />
          <DocumentMetadataDialog
            open={metadataOpen}
            onOpenChange={setMetadataOpen}
            document={detail.document}
            onSave={async (metadata) => {
              await onUpdateMetadata(detail.document.id, metadata)
              setMetadataOpen(false)
            }}
          />
        </>
      ) : null}
    </Sheet>
  )
}

function DocumentMetadataDialog({
  open,
  onOpenChange,
  document: sourceDocument,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: SourceDocument
  onSave: (metadata: EditableDocumentMetadata) => Promise<void>
}) {
  const titleId = useId()
  const descriptionId = useId()
  const tagsId = useId()
  const languageId = useId()
  const [documentName, setDocumentName] = useState(sourceDocument.documentName)
  const [description, setDescription] = useState(sourceDocument.description ?? "")
  const [tags, setTags] = useState(sourceDocument.tags.join(", "))
  const [languageHint, setLanguageHint] = useState(sourceDocument.languageHint ?? "")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDocumentName(sourceDocument.documentName)
    setDescription(sourceDocument.description ?? "")
    setTags(sourceDocument.tags.join(", "))
    setLanguageHint(sourceDocument.languageHint ?? "")
    setSaveError(null)
    setSaving(false)
  }, [open, sourceDocument])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedName = documentName.trim()
    if (!normalizedName) {
      setSaveError("A document title is required.")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await onSave({
        documentName: normalizedName,
        description: description.trim() || null,
        tags: [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))],
        languageHint: languageHint.trim() || null,
      })
    } catch (error) {
      setSaveError(errorMessage(error, "The document metadata could not be updated."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit document metadata</DialogTitle>
          <DialogDescription>
            Update the title and descriptive fields. Parsed source text and version history remain immutable.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              value={documentName}
              onChange={(event) => setDocumentName(event.target.value)}
              maxLength={512}
              required
              autoFocus
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={descriptionId}>Description</Label>
            <Textarea
              id={descriptionId}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={10_000}
              rows={4}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={tagsId}>Tags</Label>
            <Input
              id={tagsId}
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              maxLength={5_000}
              placeholder="release, policy, onboarding"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">Separate tags with commas.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={languageId}>Language hint</Label>
            <Input
              id={languageId}
              value={languageHint}
              onChange={(event) => setLanguageHint(event.target.value)}
              maxLength={64}
              placeholder="For example: English or Arabic"
              disabled={saving}
            />
          </div>
          {saveError ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{saveError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Pencil className="size-4" aria-hidden="true" />}
              {saving ? "Saving…" : "Save metadata"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DocumentProcessingStatus({
  version,
  job,
  archived,
}: {
  version: SourceDocumentVersion | null
  job?: DocumentIngestJob | null
  archived: boolean
}) {
  if (archived) return <StatusChip tone="warning">Archived</StatusChip>
  if (!version) return <StatusChip tone="neutral">No version</StatusChip>
  const status = job?.status === "failed" ? "parse_failed" : version.parseStatus
  const label = job && ACTIVE_JOB_STATUSES.has(job.status)
    ? documentJobLabel(job) ?? "Processing"
    : documentParseStatusLabel(status)
  const tone = documentParseStatusTone(status, job)
  return <StatusChip tone={tone}>{label}</StatusChip>
}

function DocumentTableSkeleton() {
  return (
    <div className="space-y-3 p-4" role="status" aria-label="Loading project documents">
      <span className="sr-only">Loading project documents</span>
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_100px] items-center gap-4 rounded-lg border border-border p-3 md:grid-cols-[minmax(0,1fr)_140px_160px_80px]">
          <div className="space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-3 w-1/3" /></div>
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="hidden h-4 w-28 md:block" />
          <Skeleton className="hidden h-8 w-16 md:block" />
        </div>
      ))}
    </div>
  )
}

function DocumentDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading document details" className="space-y-4">
      <span className="sr-only">Loading document details</span>
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-44 w-full" />
    </div>
  )
}

function DetailValue({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm text-foreground">{value || "—"}</dd>
    </div>
  )
}

/** Shared by the archive/replace confirmations and the persistent impact section. */
function DocumentImpactEntryList({ entries }: { entries: DocumentImpact["entries"] }) {
  if (!entries.length) return null
  return (
    <ul className="list-disc space-y-1 pl-5 text-xs">
      {entries.map((entry) => (
        <li key={entry.id}>
          {entry.title}
          {entry.category ? ` (${entry.category})` : ""}
          {entry.status ? ` · ${entry.status}` : ""}
        </li>
      ))}
    </ul>
  )
}

export function validateDocumentUploadFile(file: Pick<File, "name" | "size">) {
  if (file.size <= 0) return "This file is empty."
  if (file.size > DOCUMENT_UPLOAD_MAX_BYTES) return `This file exceeds the ${formatFileSize(DOCUMENT_UPLOAD_MAX_BYTES)} limit.`
  const extension = file.name.split(".").pop()?.toLowerCase()
  if (!extension || !DOCUMENT_UPLOAD_EXTENSIONS.includes(extension as (typeof DOCUMENT_UPLOAD_EXTENSIONS)[number])) {
    return "Unsupported file type. Choose a PDF, DOCX, XLSX, CSV, TXT, or Markdown file."
  }
  return undefined
}

/** Builds the multipart body in the server-required order: scope before every other field and file. */
export function buildDocumentUploadFormData(scope: ActiveProjectScope, metadata: UploadMetadata, files: File[]) {
  const formData = new FormData()
  formData.append("scope", JSON.stringify(scope))
  if (metadata.title.trim()) formData.append("title", metadata.title.trim())
  if (metadata.description.trim()) formData.append("description", metadata.description.trim())
  const tags = metadata.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
  if (tags.length) formData.append("tags", JSON.stringify(tags))
  if (metadata.languageHint.trim()) formData.append("languageHint", metadata.languageHint.trim())
  for (const file of files) formData.append("files", file, file.name)
  return formData
}

export function documentPollDelay(createdAt: string | undefined, consecutiveFailures: number, nowMs: number) {
  if (consecutiveFailures > 0) return [5_000, 15_000, 30_000][Math.min(consecutiveFailures - 1, 2)]
  const createdMs = createdAt ? Date.parse(createdAt) : nowMs
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0
  if (ageMs < 15_000) return 2_000
  if (ageMs < 120_000) return 5_000
  return 15_000
}

function isDocumentProcessing(item: DocumentListItem) {
  return Boolean(item.currentVersion && ACTIVE_PARSE_STATUSES.has(item.currentVersion.parseStatus)) || Boolean(item.job && ACTIVE_JOB_STATUSES.has(item.job.status))
}

/** The most recently started in-progress version, used to seed the poll backoff on a cold load (no tracked job yet). */
function newestInProgressVersionTimestamp(items: DocumentListItem[]): string | undefined {
  let newest: string | undefined
  let newestMs = -Infinity
  for (const item of items) {
    if (!isDocumentProcessing(item)) continue
    const candidate = item.currentVersion?.createdAt ?? item.currentVersion?.updatedAt
    if (!candidate) continue
    const candidateMs = Date.parse(candidate)
    if (Number.isFinite(candidateMs) && candidateMs > newestMs) {
      newestMs = candidateMs
      newest = candidate
    }
  }
  return newest
}

function documentListUrl(scope: ActiveProjectScope, input: {
  page: number
  pageSize: number
  lifecycleStatus?: string
  search?: string
}) {
  const query = documentScopeQuery(scope, {
    page: String(input.page),
    pageSize: String(input.pageSize),
    ...(input.lifecycleStatus ? { lifecycleStatus: input.lifecycleStatus } : {}),
    ...(input.search?.trim() ? { search: input.search.trim() } : {}),
  })
  return `/api/context/documents?${query}`
}

function documentDetailUrl(documentId: string, scope: ActiveProjectScope) {
  return `/api/context/documents/${encodeURIComponent(documentId)}?${documentScopeQuery(scope)}`
}

function documentDownloadUrl(versionId: string, scope: ActiveProjectScope) {
  return `/api/context/documents/versions/${encodeURIComponent(versionId)}/download?${documentScopeQuery(scope)}`
}

function documentJobUrl(jobId: string, scope: ActiveProjectScope) {
  return `/api/context/documents/jobs/${encodeURIComponent(jobId)}?${documentScopeQuery(scope)}`
}

function documentImpactUrl(documentId: string, scope: ActiveProjectScope) {
  return `/api/context/documents/${encodeURIComponent(documentId)}/impact?${documentScopeQuery(scope)}`
}

function documentScopeQuery(scope: ActiveProjectScope, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ scope: JSON.stringify(scope), ...extra })
  return query.toString()
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" })
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) throw new Error(errorFromResponse(body) ?? "The server returned an unexpected response.")
  return body as T
}

async function readDocumentJob(jobId: string, scope: ActiveProjectScope) {
  const response = await getJson<unknown>(documentJobUrl(jobId, scope))
  const record = asRecord(response)
  return normalizeJob(record?.job ?? response)
}

function normalizeDocumentListResponse(response: unknown): { items: DocumentListItem[]; totalCount: number } {
  const record = asRecord(response)
  const sourceItems = arrayValue(record?.items ?? record?.documents)
  const items = sourceItems.map(normalizeDocumentListItem).filter((item): item is DocumentListItem => Boolean(item))
  const totalCount = numberValue(record?.totalCount) ?? items.length
  return { items, totalCount }
}

function normalizeDocumentListItem(value: unknown): DocumentListItem | null {
  const record = asRecord(value)
  if (!record) return null
  const sourceDocument = normalizeDocument(record.document ?? value)
  if (!sourceDocument) return null
  const currentVersion = normalizeVersion(record.currentVersion ?? record.version)
    ?? (Array.isArray(record.versions) ? normalizeVersion(record.versions[0]) : null)
  const versionCount = numberValue(record.versionCount) ?? (Array.isArray(record.versions) ? record.versions.length : currentVersion ? 1 : 0)
  const job = normalizeJob(record.job)
  return { document: sourceDocument, currentVersion, versionCount, job }
}

function normalizeDocumentDetailResponse(response: unknown): DocumentDetail {
  const record = asRecord(response)
  const sourceDocument = normalizeDocument(record?.document)
  if (!sourceDocument) throw new Error("The server did not return a valid document record.")
  const versions = arrayValue(record?.versions).map(normalizeVersion).filter((version): version is SourceDocumentVersion => Boolean(version))
  const chunks = arrayValue(record?.chunks ?? record?.items).map(normalizeChunk).filter((chunk): chunk is SourceDocumentChunk => Boolean(chunk))
  return { document: sourceDocument, versions, chunks }
}

function normalizeDocumentUploadResponse(response: unknown): DocumentUploadAcceptance[] {
  const record = asRecord(response)
  return arrayValue(record?.uploads).flatMap((value) => {
    const upload = asRecord(value)
    const sourceDocument = normalizeDocument(upload?.document)
    const version = normalizeVersion(upload?.version)
    if (!sourceDocument || !version) return []
    return [{ document: sourceDocument, version, job: normalizeJob(upload?.job) }]
  })
}

/** The reprocess route returns a flat `{ document, version, job }`, unlike the batched `uploads` shape. */
function normalizeDocumentReprocessResponse(response: unknown): DocumentUploadAcceptance | null {
  const record = asRecord(response)
  const sourceDocument = normalizeDocument(record?.document)
  const version = normalizeVersion(record?.version)
  if (!sourceDocument || !version) return null
  return { document: sourceDocument, version, job: normalizeJob(record?.job) }
}

function normalizeDocumentImpactResponse(response: unknown): DocumentImpact | null {
  const responseRecord = asRecord(response)
  const record = asRecord(responseRecord?.impact) ?? responseRecord
  if (!record) return null
  const entries = arrayValue(record.entries ?? record.affectedEntries ?? record.publishedEntries).flatMap((value) => {
    const entry = asRecord(value)
    const id = textValue(entry?.entryVersionId ?? entry?.id ?? entry?.entryId)
    const title = textValue(entry?.title ?? entry?.name) ?? textValue(entry?.entryKey)
    return id && title ? [{ id, title, category: textValue(entry?.category), status: textValue(entry?.status) }] : []
  })
  const entryCount = numberValue(
    record.totalEntries
      ?? record.entryCount
      ?? record.affectedEntryCount
      ?? record.affectedPublishedKnowledgeEntryCount
      ?? record.count,
  ) ?? entries.length
  return { entryCount, entries }
}

function normalizeDocument(value: unknown): SourceDocument | null {
  const record = asRecord(value)
  const id = textValue(record?.id)
  const documentName = textValue(record?.documentName ?? record?.document_name)
  if (!id || !documentName) return null
  return {
    id,
    documentName,
    description: textValue(record?.description),
    tags: stringArray(record?.tags ?? record?.tagsJson ?? record?.tags_json),
    languageHint: textValue(record?.languageHint ?? record?.language_hint),
    documentKind: textValue(record?.documentKind ?? record?.document_kind),
    sourceConnector: textValue(record?.sourceConnector ?? record?.source_connector),
    currentVersionId: textValue(record?.currentVersionId ?? record?.current_version_id),
    lifecycleStatus: textValue(record?.lifecycleStatus ?? record?.lifecycle_status) ?? "active",
    archivedAt: textValue(record?.archivedAt ?? record?.archived_at),
    archivedReason: textValue(record?.archivedReason ?? record?.archived_reason),
    createdAt: textValue(record?.createdAt ?? record?.created_at),
    updatedAt: textValue(record?.updatedAt ?? record?.updated_at),
  }
}

function normalizeVersion(value: unknown): SourceDocumentVersion | null {
  const record = asRecord(value)
  const id = textValue(record?.id)
  if (!id) return null
  return {
    id,
    documentId: textValue(record?.documentId ?? record?.document_id) ?? undefined,
    versionNumber: numberValue(record?.versionNumber ?? record?.version_number) ?? 1,
    originalFileName: textValue(record?.originalFileName ?? record?.original_file_name) ?? "Original file",
    mimeType: textValue(record?.mimeType ?? record?.mime_type),
    fileFormat: textValue(record?.fileFormat ?? record?.file_format),
    byteSize: numberValue(record?.byteSize ?? record?.byte_size) ?? 0,
    parseStatus: textValue(record?.parseStatus ?? record?.parse_status) ?? "pending",
    parseError: textValue(record?.parseError ?? record?.parse_error),
    parseWarnings: stringArray(record?.parseWarnings ?? record?.parse_warnings ?? record?.parseWarningsJson),
    parseRecipeVersion: textValue(record?.parseRecipeVersion ?? record?.parse_recipe_version),
    chunkCount: numberValue(record?.chunkCount ?? record?.chunk_count) ?? 0,
    uploadedBy: textValue(record?.uploadedBy ?? record?.uploaded_by),
    createdAt: textValue(record?.createdAt ?? record?.created_at),
    updatedAt: textValue(record?.updatedAt ?? record?.updated_at),
  }
}

function normalizeChunk(value: unknown): SourceDocumentChunk | null {
  const record = asRecord(value)
  const id = textValue(record?.id)
  const content = textValue(record?.content)
  if (!id || content === null) return null
  return {
    id,
    section: textValue(record?.section),
    pageNumber: numberValue(record?.pageNumber ?? record?.page_number),
    chunkIndex: numberValue(record?.chunkIndex ?? record?.chunk_index) ?? 0,
    content,
    createdAt: textValue(record?.createdAt ?? record?.created_at),
  }
}

function normalizeJob(value: unknown): DocumentIngestJob | null {
  const record = asRecord(value)
  const id = textValue(record?.id)
  const status = textValue(record?.status)
  if (!id || !status) return null
  const progress = asRecord(record?.progress)
  return {
    id,
    status,
    versionId: textValue(record?.versionId ?? record?.version_id),
    phase: textValue(record?.phase),
    progress: progress ? {
      percent: numberValue(progress.percent),
      completed: numberValue(progress.completed),
      total: numberValue(progress.total),
    } : null,
    error: textValue(record?.error),
    createdAt: textValue(record?.createdAt ?? record?.created_at),
    updatedAt: textValue(record?.updatedAt ?? record?.updated_at),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : []
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : null
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string")
  if (typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

function documentParseStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "Queued",
    parsing: "Processing",
    parsed: "Ready",
    partially_parsed: "Ready with warnings",
    parse_failed: "Failed",
  }
  return labels[status] ?? status.replace(/_/g, " ")
}

function documentParseStatusTone(status: string, job?: DocumentIngestJob | null): "success" | "warning" | "error" | "info" | "neutral" {
  if (job && ACTIVE_JOB_STATUSES.has(job.status)) return "info"
  if (status === "parsed") return "success"
  if (status === "partially_parsed") return "warning"
  if (status === "parse_failed" || job?.status === "failed") return "error"
  if (status === "pending" || status === "parsing") return "info"
  return "neutral"
}

function documentJobLabel(job?: DocumentIngestJob | null) {
  if (!job) return null
  if (job.status === "completed") return "Ready"
  if (job.status === "failed") return "Failed"
  if (job.status === "cancelled") return "Cancelled"
  const phase = job.phase?.replace(/_/g, " ")
  return phase ? `${phase.charAt(0).toUpperCase()}${phase.slice(1)}` : "Processing"
}

function fileIdentity(file: Pick<File, "name" | "size" | "lastModified">) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

function errorFromResponse(value: unknown) {
  const record = asRecord(value)
  return textValue(record?.error)
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

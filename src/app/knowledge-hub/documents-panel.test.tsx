// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildDocumentUploadFormData,
  DocumentsPanel,
  DocumentUploadDialog,
  validateDocumentUploadFile,
} from "./documents-panel"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "ado-project-1",
  azureProjectName: "Project One",
  azureOrganizationUrl: "https://dev.azure.com/example",
}

describe("Documents upload dialog", () => {
  it("keeps scope first in the multipart body before metadata and files", () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" })
    const formData = buildDocumentUploadFormData(scope, {
      title: "Notes",
      description: "A document",
      tags: "planning, notes",
      languageHint: "English",
    }, [file])

    const entries = Array.from(formData.entries())
    expect(entries[0]).toEqual(["scope", JSON.stringify(scope)])
    expect(entries.map(([name]) => name)).toEqual(["scope", "title", "description", "tags", "languageHint", "files"])
    expect(entries[5]?.[1]).toBeInstanceOf(File)
  })

  it("reports client validation beside an offending file row and exposes a keyboard dropzone", () => {
    render(
      <DocumentUploadDialog
        open
        onOpenChange={vi.fn()}
        scope={scope}
        onAccepted={vi.fn()}
      />,
    )

    const dropzone = screen.getByRole("button", { name: "Add documents to upload" })
    fireEvent.keyDown(dropzone, { key: "Enter" })

    const input = screen.getByLabelText("Select documents to upload")
    const unsupported = new File(["binary"], "malware.exe", { type: "application/octet-stream" })
    fireEvent.change(input, { target: { files: [unsupported] } })

    expect(screen.getByText("malware.exe")).toBeTruthy()
    expect(screen.getByRole("alert")).toHaveTextContent("Unsupported file type")
  })

  it("accepts every M1 format and rejects empty files", () => {
    for (const extension of ["pdf", "docx", "xlsx", "csv", "txt", "md", "png", "jpg", "jpeg", "webp"]) {
      expect(validateDocumentUploadFile({ name: `file.${extension}`, size: 1 })).toBeUndefined()
    }
    expect(validateDocumentUploadFile({ name: "empty.txt", size: 0 })).toBe("This file is empty.")
  })

  it("submits English as the default OCR language", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-type": "application/json" }), url: "/api/context/documents/upload", text: async () => JSON.stringify({ uploads: [{
      document: { id: "document-1", documentName: "scan.png", tags: [], lifecycleStatus: "active" },
      version: { id: "version-1", versionNumber: 1, originalFileName: "scan.png", byteSize: 10, fileFormat: "png", parseStatus: "pending", parseWarnings: [], chunkCount: 0 },
    }] }) })
    vi.stubGlobal("fetch", fetchMock)
    render(<DocumentUploadDialog open onOpenChange={vi.fn()} scope={scope} onAccepted={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Select documents to upload"), { target: { files: [new File(["scan"], "scan.png", { type: "image/png" })] } })
    fireEvent.click(screen.getByRole("button", { name: "Upload documents" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect((fetchMock.mock.calls[0]?.[1]?.body as FormData).get("languageHint")).toBe("eng")
  })

  it("offers supported OCR languages and submits each selected file independently", async () => {
    const accepted = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: "Bad Request", headers: new Headers({ "content-type": "application/json" }), url: "/api/context/documents/upload", text: async () => JSON.stringify({ error: "First image is invalid." }) })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-type": "application/json" }), url: "/api/context/documents/upload", text: async () => JSON.stringify({ uploads: [{
        document: { id: "document-2", documentName: "second.png", tags: [], lifecycleStatus: "active" },
        version: { id: "version-2", versionNumber: 1, originalFileName: "second.png", byteSize: 10, fileFormat: "png", parseStatus: "pending", parseWarnings: [], chunkCount: 0 },
        job: { id: "job-2", status: "pending" },
      }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-type": "application/json" }), url: "/api/context/documents/upload", text: async () => JSON.stringify({ uploads: [{
        document: { id: "document-1", documentName: "first.png", tags: [], lifecycleStatus: "active" },
        version: { id: "version-1", versionNumber: 1, originalFileName: "first.png", byteSize: 10, fileFormat: "png", parseStatus: "pending", parseWarnings: [], chunkCount: 0 },
        job: { id: "job-1", status: "pending" },
      }] }) })
    vi.stubGlobal("fetch", fetchMock)
    render(<DocumentUploadDialog open onOpenChange={vi.fn()} scope={scope} onAccepted={accepted} />)

    expect(screen.getByLabelText("Select documents to upload")).toHaveAttribute("accept", expect.stringContaining(".png"))
    expect(screen.getByText(/PNG, JPEG, or WebP/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("OCR language"), { target: { value: "ara" } })
    const first = new File(["first"], "first.png", { type: "image/png" })
    const second = new File(["second"], "second.png", { type: "image/png" })
    fireEvent.change(screen.getByLabelText("Select documents to upload"), { target: { files: [first, second] } })
    fireEvent.click(screen.getByRole("button", { name: "Upload documents" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(Array.from((fetchMock.mock.calls[0]?.[1]?.body as FormData).getAll("files"))).toEqual([first])
    expect(Array.from((fetchMock.mock.calls[1]?.[1]?.body as FormData).getAll("files"))).toEqual([second])
    expect((fetchMock.mock.calls[1]?.[1]?.body as FormData).get("languageHint")).toBe("ara")
    expect(await screen.findByText("First image is invalid.")).toBeTruthy()
    expect(screen.getByText("Queued for processing")).toBeTruthy()
    expect(accepted).toHaveBeenCalledWith([expect.objectContaining({ version: expect.objectContaining({ id: "version-2" }) })])

    fireEvent.click(screen.getByRole("button", { name: "Upload documents" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(Array.from((fetchMock.mock.calls[2]?.[1]?.body as FormData).getAll("files"))).toEqual([first])
    expect(screen.getAllByText("Queued for processing")).toHaveLength(2)
    expect(accepted).toHaveBeenNthCalledWith(2, [expect.objectContaining({ version: expect.objectContaining({ id: "version-1" }) })])
    expect(accepted).toHaveBeenCalledTimes(2)
  })
})

describe("Documents panel", () => {
  it("shows OCR status, warnings, and region provenance in document details", async () => {
    const document = { id: "document-ocr", documentName: "Arabic scan", tags: [], languageHint: "ara", lifecycleStatus: "active", currentVersionId: "version-ocr" }
    const version = {
      id: "version-ocr", versionNumber: 1, originalFileName: "scan.png", byteSize: 100, fileFormat: "png",
      parseStatus: "partially_parsed", parseWarnings: ["One OCR region was below threshold."], chunkCount: 1,
      metadata: { ocr: { language: "ara", status: "partially_parsed", confidence: 76, acceptedRegionCount: 1, rejectedRegionCount: 1 } },
    }
    const chunk = { id: "chunk-1", section: "ocr-region-2", chunkIndex: 0, content: "نص موثوق", metadata: { origin: "ocr_text", language: "ara", confidence: 88, bbox: { x0: 12, y0: 34, x1: 132, y1: 79 } } }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/impact")) return { ok: true, json: async () => ({ impact: { totalEntries: 0, entries: [] } }) }
      if (url.includes(`/api/context/documents/${document.id}?`)) return { ok: true, json: async () => ({ document, versions: [version], chunks: [chunk] }) }
      return { ok: true, json: async () => ({ items: [{ document, currentVersion: version, versionCount: 1 }], totalCount: 1 }) }
    })
    vi.stubGlobal("fetch", fetchMock)
    render(<DocumentsPanel scope={scope} canManage={false} />)

    fireEvent.click(await screen.findByRole("button", { name: "Details" }))

    expect(await screen.findByText("partially parsed")).toBeTruthy()
    expect(screen.getByText("76%")).toBeTruthy()
    expect(screen.getByText("1 accepted · 1 rejected")).toBeTruthy()
    expect(screen.getByText("One OCR region was below threshold.")).toBeTruthy()
    expect(screen.getByText("ara · 88% confidence")).toBeTruthy()
    expect(screen.getByText("Region x 12, y 34 · 120×45 px")).toBeTruthy()
  })

  it("shows processing status and read controls to members without upload or archive actions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          document: {
            id: "document-1",
            documentName: "Architecture notes",
            tags: ["architecture"],
            lifecycleStatus: "active",
            currentVersionId: "version-1",
            createdAt: "2026-08-01T10:00:00.000Z",
          },
          currentVersion: {
            id: "version-1",
            versionNumber: 1,
            originalFileName: "architecture.md",
            byteSize: 1234,
            fileFormat: "md",
            parseStatus: "parsing",
            parseWarnings: [],
            chunkCount: 3,
            uploadedBy: "Ada",
            createdAt: "2026-08-01T10:00:00.000Z",
          },
          versionCount: 1,
        }],
        totalCount: 1,
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsPanel scope={scope} canManage={false} />)

    expect(await screen.findByText("Architecture notes")).toBeTruthy()
    expect(screen.getAllByText("Processing").length).toBeGreaterThan(1)
    expect(screen.getByRole("link", { name: "Download Architecture notes" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /upload documents/i })).toBeNull()
    expect(screen.queryByRole("button", { name: "Archive Architecture notes" })).toBeNull()
    expect(screen.getByText(/Ask a workspace owner or admin to manage documents from the Build Knowledge tab/)).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/context/documents?scope=")
  })

  it("lets managers edit metadata from document details and sends a scoped PATCH", async () => {
    const document = {
      id: "document-1",
      documentName: "Architecture notes",
      description: "Initial architecture context",
      tags: ["architecture"],
      languageHint: "en",
      lifecycleStatus: "active",
      currentVersionId: "version-1",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const version = {
      id: "version-1",
      versionNumber: 1,
      originalFileName: "architecture.md",
      byteSize: 1234,
      fileFormat: "md",
      parseStatus: "parsed",
      parseWarnings: [],
      chunkCount: 3,
      uploadedBy: "Ada",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "PATCH") {
        return {
          ok: true,
          json: async () => ({ document: { ...document, documentName: "Release architecture" } }),
        }
      }
      if (url.includes(`/api/context/documents/${document.id}?`)) {
        return {
          ok: true,
          json: async () => ({ document, versions: [version], chunks: [] }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          items: [{ document, currentVersion: version, versionCount: 1 }],
          totalCount: 1,
        }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsPanel scope={scope} canManage />)

    fireEvent.click(await screen.findByRole("button", { name: "Details" }))
    expect(await screen.findByRole("button", { name: "Edit metadata" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }))
    const titleInput = await screen.findByLabelText("Title")
    fireEvent.change(titleInput, { target: { value: "Release architecture" } })
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/context/documents/${document.id}`,
      expect.objectContaining({ method: "PATCH" }),
    ))
    const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    expect(patchCall).toBeTruthy()
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toMatchObject({
      scope,
      documentName: "Release architecture",
      description: document.description,
      tags: document.tags,
      languageHint: document.languageHint,
    })
  })

  it("constrains image document metadata to supported OCR languages", async () => {
    const document = { id: "document-image", documentName: "Scan", tags: [], languageHint: "eng", lifecycleStatus: "active", currentVersionId: "version-image" }
    const version = { id: "version-image", versionNumber: 1, originalFileName: "scan.webp", mimeType: "image/webp", byteSize: 10, fileFormat: "webp", parseStatus: "parsed", parseWarnings: [], chunkCount: 1 }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return { ok: true, json: async () => ({ document: { ...document, languageHint: "ara" } }) }
      if (String(input).includes(`/api/context/documents/${document.id}?`)) return { ok: true, json: async () => ({ document, versions: [version], chunks: [] }) }
      return { ok: true, json: async () => ({ items: [{ document, currentVersion: version, versionCount: 1 }], totalCount: 1 }) }
    })
    vi.stubGlobal("fetch", fetchMock)
    render(<DocumentsPanel scope={scope} canManage />)
    fireEvent.click(await screen.findByRole("button", { name: "Details" }))
    fireEvent.click(await screen.findByRole("button", { name: "Edit metadata" }))
    const language = await screen.findByLabelText("Language hint")
    expect(language.tagName).toBe("SELECT")
    expect(Array.from((language as HTMLSelectElement).options).map((option) => option.value)).toEqual(["eng", "ara"])
    fireEvent.change(language, { target: { value: "ara" } })
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(true))
    const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body)).languageHint).toBe("ara")
  })

  it("lets managers reprocess a document and starts tracking the returned job", async () => {
    const document = {
      id: "document-1",
      documentName: "Architecture notes",
      tags: [],
      lifecycleStatus: "active",
      currentVersionId: "version-1",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const version = {
      id: "version-1",
      versionNumber: 1,
      originalFileName: "architecture.md",
      byteSize: 1234,
      fileFormat: "md",
      parseStatus: "parsed",
      parseWarnings: [],
      chunkCount: 3,
      uploadedBy: "Ada",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "POST" && url.includes("/reprocess")) {
        const body = {
          document,
          version,
          job: { id: "job-1", status: "pending", versionId: version.id, createdAt: new Date().toISOString() },
        }
        // postJson reads the body via response.text() (not .json()) so it can preserve
        // the raw excerpt on non-JSON failures; the mock must implement both.
        return { ok: true, status: 202, json: async () => body, text: async () => JSON.stringify(body) }
      }
      if (url.includes("/impact")) {
        return { ok: true, json: async () => ({ document, impact: { totalEntries: 0, entries: [] } }) }
      }
      if (url.includes(`/api/context/documents/${document.id}?`)) {
        return { ok: true, json: async () => ({ document, versions: [version], chunks: [] }) }
      }
      return {
        ok: true,
        json: async () => ({ items: [{ document, currentVersion: version, versionCount: 1 }], totalCount: 1 }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsPanel scope={scope} canManage />)

    fireEvent.click(await screen.findByRole("button", { name: "Details" }))
    const reprocessButton = await screen.findByRole("button", { name: "Reprocess" })
    expect(reprocessButton).not.toBeDisabled()
    fireEvent.click(reprocessButton)

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).includes("/reprocess") && (init as RequestInit | undefined)?.method === "POST",
    )).toBe(true))
    const reprocessCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/reprocess"))
    expect(JSON.parse(String((reprocessCall?.[1] as RequestInit).body))).toEqual({ scope })

    // The tracked pending job flips isProcessing to true, which disables the button
    // (there is also a static "Processing" table-column header, so a text match alone
    // would not prove the job was actually tracked).
    await waitFor(() => expect(reprocessButton).toBeDisabled())
    expect(toast.success).toHaveBeenCalledWith("Document queued for reprocessing.")
  })

  it("hides the reprocess action from members without manage access", async () => {
    const document = {
      id: "document-1",
      documentName: "Architecture notes",
      tags: [],
      lifecycleStatus: "active",
      currentVersionId: "version-1",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const version = {
      id: "version-1",
      versionNumber: 1,
      originalFileName: "architecture.md",
      byteSize: 1234,
      fileFormat: "md",
      parseStatus: "parsed",
      parseWarnings: [],
      chunkCount: 3,
      uploadedBy: "Ada",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/impact")) return { ok: true, json: async () => ({ document, impact: { totalEntries: 0, entries: [] } }) }
      if (url.includes(`/api/context/documents/${document.id}?`)) return { ok: true, json: async () => ({ document, versions: [version], chunks: [] }) }
      return { ok: true, json: async () => ({ items: [{ document, currentVersion: version, versionCount: 1 }], totalCount: 1 }) }
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsPanel scope={scope} canManage={false} />)

    fireEvent.click(await screen.findByRole("button", { name: "Details" }))
    await screen.findByRole("heading", { name: "Version history" })
    expect(screen.queryByRole("button", { name: "Reprocess" })).toBeNull()
  })

  it("shows knowledge entries impacted by the document in the persistent impact section", async () => {
    const document = {
      id: "document-1",
      documentName: "Architecture notes",
      tags: [],
      lifecycleStatus: "active",
      currentVersionId: "version-1",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const version = {
      id: "version-1",
      versionNumber: 1,
      originalFileName: "architecture.md",
      byteSize: 1234,
      fileFormat: "md",
      parseStatus: "parsed",
      parseWarnings: [],
      chunkCount: 3,
      uploadedBy: "Ada",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/impact")) {
        return {
          ok: true,
          json: async () => ({
            document,
            impact: {
              totalEntries: 1,
              entries: [{ entryVersionId: "entry-1", category: "Policies", entryKey: "return-policy", title: "Return policy", status: "active" }],
            },
          }),
        }
      }
      if (url.includes(`/api/context/documents/${document.id}?`)) return { ok: true, json: async () => ({ document, versions: [version], chunks: [] }) }
      return { ok: true, json: async () => ({ items: [{ document, currentVersion: version, versionCount: 1 }], totalCount: 1 }) }
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsPanel scope={scope} canManage />)

    fireEvent.click(await screen.findByRole("button", { name: "Details" }))
    expect(await screen.findByText("1 entry")).toBeTruthy()
    expect(await screen.findByText(/Return policy \(Policies\) · active/)).toBeTruthy()
  })

  it("shows an empty state in the persistent impact section when no knowledge cites the document", async () => {
    const document = {
      id: "document-1",
      documentName: "Architecture notes",
      tags: [],
      lifecycleStatus: "active",
      currentVersionId: "version-1",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const version = {
      id: "version-1",
      versionNumber: 1,
      originalFileName: "architecture.md",
      byteSize: 1234,
      fileFormat: "md",
      parseStatus: "parsed",
      parseWarnings: [],
      chunkCount: 3,
      uploadedBy: "Ada",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/impact")) return { ok: true, json: async () => ({ document, impact: { totalEntries: 0, entries: [] } }) }
      if (url.includes(`/api/context/documents/${document.id}?`)) return { ok: true, json: async () => ({ document, versions: [version], chunks: [] }) }
      return { ok: true, json: async () => ({ items: [{ document, currentVersion: version, versionCount: 1 }], totalCount: 1 }) }
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsPanel scope={scope} canManage />)

    fireEvent.click(await screen.findByRole("button", { name: "Details" }))
    expect(await screen.findByText("No published knowledge cites this document.")).toBeTruthy()
    expect(screen.getByText("0 entries")).toBeTruthy()
  })

  it("shows the impact confirmation before opening the replace dialog", async () => {
    const document = {
      id: "document-1",
      documentName: "Architecture notes",
      tags: [],
      lifecycleStatus: "active",
      currentVersionId: "version-1",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const version = {
      id: "version-1",
      versionNumber: 1,
      originalFileName: "architecture.md",
      byteSize: 1234,
      fileFormat: "md",
      parseStatus: "parsed",
      parseWarnings: [],
      chunkCount: 3,
      uploadedBy: "Ada",
      createdAt: "2026-08-01T10:00:00.000Z",
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/impact")) {
        return {
          ok: true,
          json: async () => ({
            document,
            impact: {
              totalEntries: 1,
              entries: [{ entryVersionId: "entry-1", category: "Policies", entryKey: "return-policy", title: "Return policy", status: "active" }],
            },
          }),
        }
      }
      if (url.includes(`/api/context/documents/${document.id}?`)) return { ok: true, json: async () => ({ document, versions: [version], chunks: [] }) }
      return { ok: true, json: async () => ({ items: [{ document, currentVersion: version, versionCount: 1 }], totalCount: 1 }) }
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsPanel scope={scope} canManage />)

    fireEvent.click(await screen.findByRole("button", { name: "Details" }))
    await screen.findByText("1 entry")
    fireEvent.click(screen.getByRole("button", { name: "Replace version" }))

    expect(await screen.findByRole("alertdialog", { name: "Replace this document version?" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Replace document version" })).toBeNull()
    expect(screen.getByText(/1 published knowledge entry cites this document/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Continue to replace" }))
    expect(await screen.findByRole("heading", { name: "Replace document version" })).toBeTruthy()
  })
})

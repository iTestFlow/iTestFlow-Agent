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
    for (const extension of ["pdf", "docx", "xlsx", "csv", "txt", "md"]) {
      expect(validateDocumentUploadFile({ name: `file.${extension}`, size: 1 })).toBeUndefined()
    }
    expect(validateDocumentUploadFile({ name: "empty.txt", size: 0 })).toBe("This file is empty.")
  })
})

describe("Documents panel", () => {
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

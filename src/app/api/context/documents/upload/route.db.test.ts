import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  userId: `ocr_upload_owner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  documentUploadRateLimitResponse: vi.fn(async () => null),
  documentUploadSessionResponse: vi.fn(async () => null),
  hasHealthyWorkerCapability: vi.fn(async () => true),
  syncProjectDocumentEmbeddings: vi.fn(async () => ({ embeddedChunkCount: 0, removedCount: 0 })),
  writeAuditLog: vi.fn(),
}));

vi.mock("../document-route-helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("../document-route-helpers")>(),
  documentUploadRateLimitResponse: routeMocks.documentUploadRateLimitResponse,
  documentUploadSessionResponse: routeMocks.documentUploadSessionResponse,
  resolveDocumentMutationScope: async (scope: ProjectScope) => ({
    ctx: { userId: routeMocks.userId, workspace: { id: scope.workspaceId } },
    scope,
  }),
}));
vi.mock("@/modules/jobs/worker-registry.service", () => ({
  hasHealthyWorkerCapability: routeMocks.hasHealthyWorkerCapability,
}));
vi.mock("@/modules/rag/embedding-store.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/rag/embedding-store.service")>(),
  syncProjectDocumentEmbeddings: routeMocks.syncProjectDocumentEmbeddings,
}));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: routeMocks.writeAuditLog }));

import { POST } from "./route";
import { setDocumentStorageBackendForTests } from "@/modules/documents/document-storage.service";
import { getJob } from "@/modules/jobs/job-queue.service";
import { runUploadedDocumentIngestJob } from "@/modules/jobs/uploaded-document-ingest.handler";
import { retrieveStoredProjectContext } from "@/modules/rag/project-context-store.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedMembership, seedProject, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";

const WS = uniqueTestId("ws_ocr_upload");
const ORG = `https://dev.azure.com/${WS}`;
const PROJECT = uniqueTestId("az_ocr_upload");
const scope: ProjectScope = {
  workspaceId: WS,
  projectId: PROJECT,
  azureProjectId: PROJECT,
  azureProjectName: "OCR upload flow",
  azureOrganizationUrl: ORG,
};

let previousStorageRoot: string | undefined;
let storageRoot: string;

describeDb("image upload-to-context flow (DB-backed)", () => {
  beforeAll(async () => {
    previousStorageRoot = process.env.DOCUMENT_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(tmpdir(), "itf-ocr-upload-flow-"));
    process.env.DOCUMENT_STORAGE_ROOT = storageRoot;
    setDocumentStorageBackendForTests(undefined);
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedUser({ id: routeMocks.userId, email: `${routeMocks.userId}@example.test` });
    await seedMembership({ workspaceId: WS, userId: routeMocks.userId, role: "owner" });
    await seedProject({
      workspaceId: WS,
      orgUrl: ORG,
      azureProjectId: PROJECT,
      azureProjectName: scope.azureProjectName,
    });
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM jobs WHERE workspace_id = @workspaceId`, { workspaceId: WS });
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @projectId`, { projectId: PROJECT });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJECT });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJECT });
    await sqlRun(`UPDATE project_source_documents SET current_version_id = NULL WHERE workspace_id = @workspaceId`, { workspaceId: WS });
    await sqlRun(`DELETE FROM project_source_document_versions WHERE workspace_id = @workspaceId`, { workspaceId: WS });
    await sqlRun(`DELETE FROM project_source_documents WHERE workspace_id = @workspaceId`, { workspaceId: WS });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [routeMocks.userId] });
    await resetDatabaseForTests();
    setDocumentStorageBackendForTests(undefined);
    if (previousStorageRoot === undefined) delete process.env.DOCUMENT_STORAGE_ROOT;
    else process.env.DOCUMENT_STORAGE_ROOT = previousStorageRoot;
    await rm(storageRoot, { recursive: true, force: true });
  });

  it.each([
    {
      language: "eng",
      visibleText: "PAYMENT GATEWAY",
      expectedText: "PAYMENT GATEWAY",
      direction: "ltr",
      fileName: "payment-context.png",
      expectedDocumentName: "payment-context",
    },
    {
      language: "ara",
      visibleText: "مرحبا",
      expectedText: "مرحبا",
      direction: "rtl",
      fileName: "القائمة-images.png",
      expectedDocumentName: "القائمة-images",
    },
  ] as const)("uploads and retrieves real $language image text", async ({ language, visibleText, expectedText, direction, fileName, expectedDocumentName }) => {
    const image = await sharp(Buffer.from(
      `<svg width="800" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="400" y="105" text-anchor="middle" direction="${direction}" font-family="DejaVu Sans" font-size="64">${visibleText}</text></svg>`,
    )).png().toBuffer();
    const form = new FormData();
    form.append("scope", JSON.stringify(scope));
    form.append("languageHint", language);
    form.append("files", new Blob([toArrayBuffer(image)], { type: "image/png" }), fileName);

    const response = await POST(new Request("http://localhost/api/context/documents/upload", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(202);
    const payload = await response.json() as {
      failures: unknown[];
      uploads: Array<{
        document: { id: string; documentKind: string; documentName: string };
        version: { id: string; originalFileName: string };
        jobId: string | null;
        queueError: string | null;
      }>;
    };
    expect(payload.failures).toEqual([]);
    expect(payload.uploads).toHaveLength(1);
    expect(payload.uploads[0]?.document.documentKind).toBe("image");
    expect(payload.uploads[0]?.document.documentName).toBe(expectedDocumentName);
    expect(payload.uploads[0]?.version.originalFileName).toBe(fileName);

    const upload = payload.uploads[0]!;
    expect(upload.queueError).toBeNull();
    expect(upload.jobId).toEqual(expect.any(String));
    const job = await getJob({ id: upload.jobId!, workspaceId: WS, projectId: PROJECT });
    expect(job).toBeTruthy();
    const controller = new AbortController();
    const result = await runUploadedDocumentIngestJob(job!, {
      workerId: uniqueTestId("ocr_worker"),
      signal: controller.signal,
      updateProgress: async () => undefined,
    });
    expect(result).toMatchObject({ outcome: "parsed", parseStatus: "parsed", chunkCount: 1 });

    const retrieved = await retrieveStoredProjectContext({
      scope,
      query: expectedText,
      embeddingProvider: null,
      rerankProvider: null,
      sourceKinds: ["uploaded_document"],
    });
    expect(retrieved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "uploaded_document",
        documentId: upload.document.id,
        documentVersionId: upload.version.id,
        content: expect.stringContaining(expectedText),
      }),
    ]));
  }, 30_000);
});

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

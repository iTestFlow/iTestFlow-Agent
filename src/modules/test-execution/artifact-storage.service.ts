import "server-only";

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { LocalFilesystemStorageBackend } from "@/modules/documents/storage/local-filesystem-backend";
import type { StorageBackend } from "@/modules/documents/storage/storage-backend.port";

/**
 * Evidence artifact storage for test execution runs. Reuses the generic
 * content-addressed StorageBackend but with its OWN root directory
 * (EXECUTION_ARTIFACT_STORAGE_ROOT, default data/execution-artifacts):
 * regenerable evidence gets an independent retention and backup policy from
 * user-uploaded documents, and content-address dedupe stays within each
 * corpus.
 */

const DEFAULT_EXECUTION_ARTIFACT_ROOT = "data/execution-artifacts";

export function resolveExecutionArtifactRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.EXECUTION_ARTIFACT_STORAGE_ROOT?.trim() || DEFAULT_EXECUTION_ARTIFACT_ROOT;
}

let backend: StorageBackend | null = null;
let overrideForTests: StorageBackend | null = null;

export function getExecutionArtifactStorageBackend(): StorageBackend {
  if (overrideForTests) return overrideForTests;
  if (!backend) {
    backend = new LocalFilesystemStorageBackend({ rootDirectory: resolveExecutionArtifactRoot() });
  }
  return backend;
}

export function setExecutionArtifactStorageBackendForTests(replacement: StorageBackend | null): void {
  overrideForTests = replacement;
}

/** Store a small in-memory evidence buffer; returns its storage identity. */
export async function putExecutionArtifact(input: {
  workspaceId: string;
  bytes: Buffer;
}): Promise<{ storageKey: string; contentSha256: string; byteSize: number }> {
  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const result = await getExecutionArtifactStorageBackend().put({
    workspaceId: input.workspaceId,
    contentSha256,
    content: Readable.from(input.bytes),
    expectedByteSize: input.bytes.length,
  });
  return { storageKey: result.storageKey, contentSha256, byteSize: result.byteSize };
}

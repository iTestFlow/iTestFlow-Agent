import "server-only";

import {
  createLocalFilesystemStorageBackend,
} from "./storage/local-filesystem-backend";
import type { StorageBackend } from "./storage/storage-backend.port";

/**
 * Returns the private document-object store used by M1 uploads and downloads.
 * The storage port deliberately stays narrow so an object-store implementation
 * can replace this factory later without changing route or worker code.
 */
let storageBackend: StorageBackend | undefined;

export function getDocumentStorageBackend(): StorageBackend {
  if (!storageBackend) storageBackend = createLocalFilesystemStorageBackend();
  return storageBackend;
}

/** Test seam: production callers should use getDocumentStorageBackend(). */
export function setDocumentStorageBackendForTests(backend: StorageBackend | undefined): void {
  storageBackend = backend;
}

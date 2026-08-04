import "server-only";

import type { Readable } from "node:stream";

/** Storage backends intentionally expose only blob operations. */
export const DOCUMENT_STORAGE_BACKENDS = ["local_fs", "s3", "azure_blob"] as const;
export type DocumentStorageBackendKind = (typeof DOCUMENT_STORAGE_BACKENDS)[number];

export type StorageObjectReference = {
  storageKey: string;
};

export type StoragePutInput = {
  /** Trusted workspace id; never a client-selected path. */
  workspaceId: string;
  /** Lower-case SHA-256 of the complete byte stream. */
  contentSha256: string;
  /** The blob bytes. A stream keeps uploads out of process memory. */
  content: Readable | AsyncIterable<Uint8Array>;
  /** Optional upload-side size check, enforced by the concrete backend. */
  expectedByteSize?: number;
};

export type StoragePutResult = {
  storageKey: string;
  byteSize: number;
  /** False when the immutable, content-addressed blob was already present. */
  created: boolean;
};

export type StorageDeleteResult = {
  deleted: boolean;
};

/**
 * Narrow storage port used by source-document registration and downloads.
 * Future S3/MinIO implementations must preserve the opaque `storageKey`
 * contract; callers never build filesystem paths or provider object URLs.
 */
export interface StorageBackend {
  readonly kind: DocumentStorageBackendKind;
  put(input: StoragePutInput): Promise<StoragePutResult>;
  getStream(input: StorageObjectReference): Promise<Readable>;
  exists(input: StorageObjectReference): Promise<boolean>;
  delete(input: StorageObjectReference): Promise<StorageDeleteResult>;
}

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(storageKey: string) {
    super(`Stored document object was not found: ${storageKey}`);
    this.name = "StorageObjectNotFoundError";
  }
}

export class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageIntegrityError";
  }
}

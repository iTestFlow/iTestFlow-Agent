import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type StorageBackend,
  type StorageDeleteResult,
  type StorageObjectReference,
  type StoragePutInput,
  type StoragePutResult,
  StorageIntegrityError,
  StorageObjectNotFoundError,
  StorageValidationError,
} from "./storage-backend.port";

const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_WORKSPACE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_DOCUMENT_STORAGE_ROOT = path.join("data", "document-store");

export type LocalFilesystemStorageBackendOptions = {
  /** Defaults to DOCUMENT_STORAGE_ROOT, then data/document-store under cwd. */
  rootDirectory?: string;
};

/**
 * Resolves the configurable root once, before deriving any object paths.  A
 * relative setting is deliberately relative to the process working directory,
 * never to a caller-provided document name or object key.
 */
export function resolveDocumentStorageRoot(rootDirectory?: string): string {
  const configured = rootDirectory?.trim() || process.env.DOCUMENT_STORAGE_ROOT?.trim();
  return path.resolve(configured || DEFAULT_DOCUMENT_STORAGE_ROOT);
}

export function normalizeDocumentContentSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CONTENT_SHA256_PATTERN.test(normalized)) {
    throw new StorageValidationError("Document content SHA-256 must be a 64-character hexadecimal digest.");
  }
  return normalized;
}

export function assertDocumentStorageWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (
    !workspaceId ||
    workspaceId === "." ||
    workspaceId === ".." ||
    !SAFE_WORKSPACE_SEGMENT_PATTERN.test(workspaceId)
  ) {
    throw new StorageValidationError("Document storage requires a safe, non-empty workspace id.");
  }
  return workspaceId;
}

/**
 * Content-addressed, POSIX-formatted keys remain portable across filesystem and
 * future object-store backends.  Keys are opaque outside the storage module.
 */
export function deriveLocalFilesystemStorageKey(input: {
  workspaceId: string;
  contentSha256: string;
}): string {
  const workspaceId = assertDocumentStorageWorkspaceId(input.workspaceId);
  const contentSha256 = normalizeDocumentContentSha256(input.contentSha256);
  return path.posix.join("ws", workspaceId, contentSha256.slice(0, 2), contentSha256);
}

function assertExpectedByteSize(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageValidationError("Document byte size must be a non-negative safe integer.");
  }
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

function asReadable(content: StoragePutInput["content"]): Readable {
  return content instanceof Readable ? content : Readable.from(content);
}

/**
 * Local, private blob store.  The backend validates both generated and supplied
 * keys, resolves every path below a fixed root, writes through a temporary file,
 * and atomically links it into the content-addressed location without replacing
 * an already-present blob.
 */
export class LocalFilesystemStorageBackend implements StorageBackend {
  readonly kind = "local_fs" as const;
  readonly rootDirectory: string;

  constructor(options: LocalFilesystemStorageBackendOptions = {}) {
    this.rootDirectory = resolveDocumentStorageRoot(options.rootDirectory);
  }

  async put(input: StoragePutInput): Promise<StoragePutResult> {
    const contentSha256 = normalizeDocumentContentSha256(input.contentSha256);
    const expectedByteSize = assertExpectedByteSize(input.expectedByteSize);
    const storageKey = deriveLocalFilesystemStorageKey({
      workspaceId: input.workspaceId,
      contentSha256,
    });
    const targetPath = this.resolveStoragePath(storageKey);

    await mkdir(path.dirname(targetPath), { recursive: true });
    const existingByteSize = await this.regularFileSize(targetPath);
    if (existingByteSize !== undefined) {
      this.assertExistingByteSize(storageKey, existingByteSize, expectedByteSize);
      return { storageKey, byteSize: existingByteSize, created: false };
    }

    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.${contentSha256}.${randomUUID()}.uploading`,
    );
    let byteSize = 0;
    const hash = createHash("sha256");
    const hashingTransform = new Transform({
      transform(chunk: Buffer | Uint8Array | string, encoding, callback) {
        try {
          const bytes = Buffer.isBuffer(chunk)
            ? chunk
            : typeof chunk === "string"
              ? Buffer.from(chunk, encoding)
              : Buffer.from(chunk);
          hash.update(bytes);
          byteSize += bytes.byteLength;
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });

    try {
      await pipeline(
        asReadable(input.content),
        hashingTransform,
        createWriteStream(temporaryPath, { flags: "wx" }),
      );

      const actualContentSha256 = hash.digest("hex");
      if (actualContentSha256 !== contentSha256) {
        throw new StorageIntegrityError("Stored document bytes do not match the declared SHA-256 digest.");
      }
      if (expectedByteSize !== undefined && byteSize !== expectedByteSize) {
        throw new StorageIntegrityError("Stored document byte size does not match the expected byte size.");
      }

      try {
        // link() is atomic and refuses to replace a file another request wrote.
        await link(temporaryPath, targetPath);
        return { storageKey, byteSize, created: true };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;

        const concurrentByteSize = await this.regularFileSize(targetPath);
        if (concurrentByteSize === undefined) throw error;
        this.assertExistingByteSize(storageKey, concurrentByteSize, expectedByteSize);
        return { storageKey, byteSize: concurrentByteSize, created: false };
      }
    } finally {
      // `rm --force` handles failed streams and the successful link case alike.
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async getStream(input: StorageObjectReference): Promise<Readable> {
    const storagePath = this.resolveStoragePath(input.storageKey);
    const byteSize = await this.regularFileSize(storagePath);
    if (byteSize === undefined) throw new StorageObjectNotFoundError(input.storageKey);
    return createReadStream(storagePath);
  }

  async exists(input: StorageObjectReference): Promise<boolean> {
    return (await this.regularFileSize(this.resolveStoragePath(input.storageKey))) !== undefined;
  }

  async delete(input: StorageObjectReference): Promise<StorageDeleteResult> {
    const storagePath = this.resolveStoragePath(input.storageKey);
    const byteSize = await this.regularFileSize(storagePath);
    if (byteSize === undefined) return { deleted: false };

    try {
      await unlink(storagePath);
      return { deleted: true };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { deleted: false };
      throw error;
    }
  }

  private resolveStoragePath(storageKey: string): string {
    this.assertCanonicalStorageKey(storageKey);
    const resolved = path.resolve(this.rootDirectory, ...storageKey.split("/"));
    const relativeToRoot = path.relative(this.rootDirectory, resolved);
    if (
      !relativeToRoot ||
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new StorageValidationError("Document storage key resolves outside the configured root.");
    }
    return resolved;
  }

  private assertCanonicalStorageKey(storageKey: string) {
    if (
      !storageKey ||
      storageKey.includes("\\") ||
      storageKey.includes("\0") ||
      storageKey.startsWith("/") ||
      storageKey.endsWith("/")
    ) {
      throw new StorageValidationError("Document storage key is invalid.");
    }

    const parts = storageKey.split("/");
    if (parts.length !== 4 || parts[0] !== "ws") {
      throw new StorageValidationError("Document storage key is outside the content-addressed namespace.");
    }

    const [, workspaceId, hashPrefix, contentSha256] = parts;
    const expected = deriveLocalFilesystemStorageKey({ workspaceId, contentSha256 });
    if (storageKey !== expected || hashPrefix !== contentSha256.slice(0, 2)) {
      throw new StorageValidationError("Document storage key is not a canonical content-addressed key.");
    }
  }

  private async regularFileSize(storagePath: string): Promise<number | undefined> {
    try {
      const stats = await lstat(storagePath);
      if (!stats.isFile()) {
        throw new StorageIntegrityError("Document storage object is not a regular file.");
      }
      return stats.size;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private assertExistingByteSize(storageKey: string, byteSize: number, expectedByteSize: number | undefined) {
    if (expectedByteSize !== undefined && byteSize !== expectedByteSize) {
      throw new StorageIntegrityError(`Existing stored document size does not match ${storageKey}.`);
    }
  }
}

export function createLocalFilesystemStorageBackend(
  options: LocalFilesystemStorageBackendOptions = {},
): LocalFilesystemStorageBackend {
  return new LocalFilesystemStorageBackend(options);
}

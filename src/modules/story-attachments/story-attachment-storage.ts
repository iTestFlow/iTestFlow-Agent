import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-]+$/;
const DEFAULT_STORY_ATTACHMENT_STORAGE_ROOT = path.join("data", "story-attachment-store");

export type StoryAttachmentStoredObject = {
  storageKey: string;
  byteSize: number;
  created: boolean;
};

export class StoryAttachmentStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryAttachmentStorageError";
  }
}

/** Uses its own root so a story tombstone never owns a Knowledge Hub blob. */
export function resolveStoryAttachmentStorageRoot(rootDirectory?: string): string {
  const configured = rootDirectory?.trim() || process.env.STORY_ATTACHMENT_STORAGE_ROOT?.trim();
  return path.resolve(configured || DEFAULT_STORY_ATTACHMENT_STORAGE_ROOT);
}

export function assertStoryAttachmentId(value: string): string {
  const attachmentId = value.trim();
  if (!attachmentId || !SAFE_ATTACHMENT_ID.test(attachmentId) || attachmentId === "." || attachmentId === "..") {
    throw new StoryAttachmentStorageError("Story attachment storage requires a safe attachment id.");
  }
  return attachmentId;
}

export function storyAttachmentOriginalStorageKey(attachmentId: string): string {
  return path.posix.join("attachments", assertStoryAttachmentId(attachmentId), "original");
}

export function storyAttachmentVisualStorageKey(input: {
  attachmentId: string;
  parseGeneration: number;
  ordinal: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}): string {
  const parseGeneration = positiveInteger(input.parseGeneration, "Parse generation");
  const ordinal = nonNegativeInteger(input.ordinal, "Visual ordinal");
  const extension = input.mimeType === "image/png" ? "png" : input.mimeType === "image/jpeg" ? "jpg" : "webp";
  return path.posix.join("attachments", assertStoryAttachmentId(input.attachmentId), "derived", String(parseGeneration), `${ordinal}.${extension}`);
}

export class StoryAttachmentStorage {
  readonly rootDirectory: string;

  constructor(rootDirectory?: string) {
    this.rootDirectory = resolveStoryAttachmentStorageRoot(rootDirectory);
  }

  async putOriginal(input: {
    attachmentId: string;
    data: Uint8Array;
    contentSha256: string;
  }): Promise<StoryAttachmentStoredObject> {
    const data = Buffer.from(input.data);
    const expectedHash = normalizeSha256(input.contentSha256);
    const actualHash = createHash("sha256").update(data).digest("hex");
    if (actualHash !== expectedHash) {
      throw new StoryAttachmentStorageError("Attachment bytes do not match the declared SHA-256 digest.");
    }
    return this.put(storyAttachmentOriginalStorageKey(input.attachmentId), data);
  }

  async putVisual(input: {
    attachmentId: string;
    parseGeneration: number;
    ordinal: number;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    data: Uint8Array;
  }): Promise<StoryAttachmentStoredObject> {
    return this.put(storyAttachmentVisualStorageKey(input), Buffer.from(input.data));
  }

  async read(storageKey: string): Promise<Buffer> {
    const storagePath = this.resolveStoragePath(storageKey);
    try {
      const info = await lstat(storagePath);
      if (!info.isFile()) throw new StoryAttachmentStorageError("Story attachment storage object is not a regular file.");
      return await readFile(storagePath);
    } catch (error) {
      if (error instanceof StoryAttachmentStorageError) throw error;
      if (isNodeError(error, "ENOENT")) throw new StoryAttachmentStorageError("Story attachment storage object was not found.");
      throw error;
    }
  }

  async deleteAttachmentTree(attachmentId: string): Promise<void> {
    const directory = this.resolveAttachmentDirectory(attachmentId);
    await rm(directory, { recursive: true, force: true });
  }

  /** Removes only stale derived output; the immutable original remains available for a retry. */
  async deleteVisualGeneration(attachmentId: string, parseGeneration: number): Promise<void> {
    const directory = path.resolve(
      this.resolveAttachmentDirectory(attachmentId),
      "derived",
      String(positiveInteger(parseGeneration, "Parse generation")),
    );
    this.assertWithinRoot(directory);
    await rm(directory, { recursive: true, force: true });
  }

  /**
   * Clears only completed or failed generations before the current parser job
   * starts. The current generation is deliberately untouched so a duplicate
   * worker cannot erase its own in-flight output.
   */
  async deleteVisualGenerationsBefore(attachmentId: string, parseGeneration: number): Promise<void> {
    const currentGeneration = positiveInteger(parseGeneration, "Parse generation");
    const derivedDirectory = path.resolve(this.resolveAttachmentDirectory(attachmentId), "derived");
    this.assertWithinRoot(derivedDirectory);
    try {
      const entries = await readdir(derivedDirectory, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) return;
        const generation = Number(entry.name);
        if (!Number.isSafeInteger(generation) || generation >= currentGeneration) return;
        const directory = path.resolve(derivedDirectory, entry.name);
        this.assertWithinRoot(directory);
        await rm(directory, { recursive: true, force: true });
      }));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }

  private async put(storageKey: string, data: Buffer): Promise<StoryAttachmentStoredObject> {
    const targetPath = this.resolveStoragePath(storageKey);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const existing = await this.regularFileSize(targetPath);
    if (existing !== undefined) return { storageKey, byteSize: existing, created: false };

    const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.uploading`);
    try {
      await writeFile(temporaryPath, data, { flag: "wx" });
      try {
        // Hard-linking is atomic and refuses to overwrite an object created by
        // a concurrent retry for the same attachment generation.
        await link(temporaryPath, targetPath);
        return { storageKey, byteSize: data.byteLength, created: true };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const concurrentSize = await this.regularFileSize(targetPath);
        if (concurrentSize === undefined) throw error;
        return { storageKey, byteSize: concurrentSize, created: false };
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private resolveAttachmentDirectory(attachmentId: string): string {
    const directory = path.resolve(this.rootDirectory, "attachments", assertStoryAttachmentId(attachmentId));
    this.assertWithinRoot(directory);
    return directory;
  }

  private resolveStoragePath(storageKey: string): string {
    this.assertCanonicalStorageKey(storageKey);
    const resolved = path.resolve(this.rootDirectory, ...storageKey.split("/"));
    this.assertWithinRoot(resolved);
    return resolved;
  }

  private assertWithinRoot(resolved: string): void {
    const relative = path.relative(this.rootDirectory, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new StoryAttachmentStorageError("Story attachment storage key resolves outside the configured root.");
    }
  }

  private assertCanonicalStorageKey(storageKey: string): void {
    if (!storageKey || storageKey.includes("\\") || storageKey.includes("\0") || storageKey.startsWith("/") || storageKey.endsWith("/")) {
      throw new StoryAttachmentStorageError("Story attachment storage key is invalid.");
    }
    const parts = storageKey.split("/");
    if (parts.length === 3 && parts[0] === "attachments" && parts[2] === "original") {
      if (storageKey !== storyAttachmentOriginalStorageKey(parts[1])) {
        throw new StoryAttachmentStorageError("Story attachment storage key is not canonical.");
      }
      return;
    }
    if (parts.length === 5 && parts[0] === "attachments" && parts[2] === "derived") {
      const generation = Number(parts[3]);
      const match = /^(\d+)\.(png|jpg|webp)$/.exec(parts[4]);
      if (!match) throw new StoryAttachmentStorageError("Story attachment visual key is invalid.");
      const mimeType = match[2] === "png" ? "image/png" : match[2] === "jpg" ? "image/jpeg" : "image/webp";
      if (storageKey !== storyAttachmentVisualStorageKey({
        attachmentId: parts[1], parseGeneration: generation, ordinal: Number(match[1]), mimeType,
      })) {
        throw new StoryAttachmentStorageError("Story attachment visual key is not canonical.");
      }
      return;
    }
    throw new StoryAttachmentStorageError("Story attachment storage key is outside its private namespace.");
  }

  private async regularFileSize(storagePath: string): Promise<number | undefined> {
    try {
      const info = await lstat(storagePath);
      if (!info.isFile()) throw new StoryAttachmentStorageError("Story attachment storage object is not a regular file.");
      return info.size;
    } catch (error) {
      if (error instanceof StoryAttachmentStorageError) throw error;
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }
}

export function createStoryAttachmentStorage(rootDirectory?: string): StoryAttachmentStorage {
  return new StoryAttachmentStorage(rootDirectory);
}

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new StoryAttachmentStorageError("Story attachment content SHA-256 must be a 64-character hexadecimal digest.");
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new StoryAttachmentStorageError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StoryAttachmentStorageError(`${label} must be a non-negative integer.`);
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

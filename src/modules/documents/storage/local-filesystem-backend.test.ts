import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalFilesystemStorageBackend,
  deriveLocalFilesystemStorageKey,
} from "./local-filesystem-backend";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalFilesystemStorageBackend", () => {
  it("stores content by verified immutable hash and deduplicates a second put", async () => {
    const root = await mkdtemp(join(tmpdir(), "itestflow-document-store-test-"));
    roots.push(root);
    const backend = createLocalFilesystemStorageBackend({ rootDirectory: root });
    const content = Buffer.from("source bytes", "utf8");
    const contentSha256 = createHash("sha256").update(content).digest("hex");

    const first = await backend.put({
      workspaceId: "workspace_1",
      contentSha256,
      expectedByteSize: content.byteLength,
      content: Readable.from([content]),
    });
    const second = await backend.put({
      workspaceId: "workspace_1",
      contentSha256,
      expectedByteSize: content.byteLength,
      content: Readable.from([content]),
    });

    expect(first).toEqual({
      storageKey: deriveLocalFilesystemStorageKey({ workspaceId: "workspace_1", contentSha256 }),
      byteSize: content.byteLength,
      created: true,
    });
    expect(second).toEqual({ ...first, created: false });
    await expect(readAll(await backend.getStream({ storageKey: first.storageKey }))).resolves.toEqual(content);
  });

  it("rejects opaque keys that would escape the configured storage root", async () => {
    const root = await mkdtemp(join(tmpdir(), "itestflow-document-store-test-"));
    roots.push(root);
    const backend = createLocalFilesystemStorageBackend({ rootDirectory: root });

    await expect(backend.getStream({ storageKey: "ws/workspace_1/aa/../../outside" }))
      .rejects.toThrow(/invalid|outside/i);
  });
});

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return Buffer.concat(chunks);
}

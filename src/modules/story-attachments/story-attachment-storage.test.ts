import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStoryAttachmentStorage } from "./story-attachment-storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("StoryAttachmentStorage", () => {
  it("keeps equal bytes in private attachment trees so one tombstone cannot remove another", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "itestflow-story-attachment-store-"));
    roots.push(root);
    const storage = createStoryAttachmentStorage(root);
    const data = Buffer.from("same provider attachment bytes");
    const contentSha256 = createHash("sha256").update(data).digest("hex");

    const first = await storage.putOriginal({ attachmentId: "story_attachment_one", data, contentSha256 });
    const second = await storage.putOriginal({ attachmentId: "story_attachment_two", data, contentSha256 });

    expect(first.storageKey).not.toBe(second.storageKey);
    await storage.deleteAttachmentTree("story_attachment_one");
    await expect(storage.read(first.storageKey)).rejects.toThrow(/not found/i);
    await expect(storage.read(second.storageKey)).resolves.toEqual(data);
  });

  it("removes a stale visual generation without deleting immutable original bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "itestflow-story-attachment-store-"));
    roots.push(root);
    const storage = createStoryAttachmentStorage(root);
    const original = Buffer.from("original bytes");
    const contentSha256 = createHash("sha256").update(original).digest("hex");
    const source = await storage.putOriginal({ attachmentId: "story_attachment_one", data: original, contentSha256 });
    const visual = await storage.putVisual({
      attachmentId: "story_attachment_one",
      parseGeneration: 1,
      ordinal: 0,
      mimeType: "image/jpeg",
      data: Buffer.from("derived visual"),
    });

    await storage.deleteVisualGeneration("story_attachment_one", 1);

    await expect(storage.read(source.storageKey)).resolves.toEqual(original);
    await expect(storage.read(visual.storageKey)).rejects.toThrow(/not found/i);
  });

  it("removes only visual generations older than the parser generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "itestflow-story-attachment-store-"));
    roots.push(root);
    const storage = createStoryAttachmentStorage(root);
    const original = Buffer.from("original bytes");
    const contentSha256 = createHash("sha256").update(original).digest("hex");
    const source = await storage.putOriginal({ attachmentId: "story_attachment_one", data: original, contentSha256 });
    const prior = await storage.putVisual({
      attachmentId: "story_attachment_one", parseGeneration: 1, ordinal: 0, mimeType: "image/jpeg", data: Buffer.from("prior"),
    });
    const current = await storage.putVisual({
      attachmentId: "story_attachment_one", parseGeneration: 2, ordinal: 0, mimeType: "image/jpeg", data: Buffer.from("current"),
    });

    await storage.deleteVisualGenerationsBefore("story_attachment_one", 2);

    await expect(storage.read(source.storageKey)).resolves.toEqual(original);
    await expect(storage.read(prior.storageKey)).rejects.toThrow(/not found/i);
    await expect(storage.read(current.storageKey)).resolves.toEqual(Buffer.from("current"));
  });
});

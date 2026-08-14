import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  removeStreamedDocumentMultipart,
  streamDocumentUploadMultipart,
} from "./streaming-multipart-upload";

const ORIGINAL_UPLOAD_LIMIT = process.env.DOCUMENT_MAX_UPLOAD_BYTES;

afterEach(() => {
  if (ORIGINAL_UPLOAD_LIMIT === undefined) delete process.env.DOCUMENT_MAX_UPLOAD_BYTES;
  else process.env.DOCUMENT_MAX_UPLOAD_BYTES = ORIGINAL_UPLOAD_LIMIT;
});

function multipartRequest(contents: Uint8Array) {
  const form = new FormData();
  // Ordering is deliberate: the route requires trusted scope metadata before a
  // file stream begins, and this test exercises the same multipart contract.
  form.append("scope", JSON.stringify({ projectId: "p", workspaceId: "w", azureProjectId: "az", azureProjectName: "Azure", azureOrganizationUrl: "https://example.test" }));
  const bytes = contents.buffer.slice(
    contents.byteOffset,
    contents.byteOffset + contents.byteLength,
  ) as ArrayBuffer;
  form.append("files", new Blob([bytes], { type: "text/plain" }), "sample.txt");
  return new Request("http://localhost/api/context/documents/upload", { method: "POST", body: form });
}

async function leakedUploadTempDirs(before: string[]) {
  const after = await readdir(tmpdir());
  return after.filter((name) => !before.includes(name) && name.startsWith("itestflow-document-upload-"));
}

describe("streamDocumentUploadMultipart", () => {
  it("preserves multipart file order when later writes finish first", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "1048576";
    const form = new FormData();
    form.append("scope", JSON.stringify({ projectId: "p" }));
    form.append("files", new Blob([new Uint8Array(500_000)]), "first.bin");
    form.append("files", new Blob([new Uint8Array(1)]), "second.bin");
    const upload = await streamDocumentUploadMultipart(new Request("http://localhost/upload", { method: "POST", body: form }));
    try {
      expect(upload.files.map((file) => file.originalFileName)).toEqual(["first.bin", "second.bin"]);
    } finally {
      await removeStreamedDocumentMultipart(upload);
    }
  });

  it("enforces the actual multipart byte cap when Content-Length is absent", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "128";
    const request = multipartRequest(new Uint8Array(512));
    expect(request.headers.get("content-length")).toBeNull();

    await expect(streamDocumentUploadMultipart(request)).rejects.toMatchObject({
      message: "The multipart upload exceeds the configured size limit.",
    });
  });

  it("accepts raw file bytes at the configured cap despite bounded multipart framing", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "1024";
    const upload = await streamDocumentUploadMultipart(multipartRequest(new Uint8Array(1024)));
    try {
      expect(upload.files[0]).toMatchObject({ byteSize: 1024 });
    } finally {
      await removeStreamedDocumentMultipart(upload);
    }
  });

  it("leaves no orphaned temp directory or locked temp file when an oversized upload aborts mid-stream", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "2048";
    const request = multipartRequest(new Uint8Array(8192));
    const before = await readdir(tmpdir());

    // Without destroying (and awaiting the close of) the destination write
    // stream, its fd stays open and the request's temp directory can never be
    // fully removed — this must reject with the original size-limit error,
    // not a masked filesystem error from a failed cleanup attempt.
    await expect(streamDocumentUploadMultipart(request)).rejects.toThrow();

    expect(await leakedUploadTempDirs(before)).toEqual([]);
  });

  it("settles active file writes before cleaning up a request-wide multipart overflow", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "1100000";
    const form = new FormData();
    form.append("scope", JSON.stringify({ projectId: "p" }));
    form.append("files", new Blob([new Uint8Array(1_100_000)]), "first.bin");
    form.append("files", new Blob([new Uint8Array(1_100_000)]), "second.bin");
    const encoded = new Request("http://localhost/upload", { method: "POST", body: form });
    const body = new Uint8Array(await encoded.arrayBuffer());
    let offset = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (offset >= body.byteLength) {
          controller.close();
          return;
        }
        const next = body.subarray(offset, Math.min(offset + 64 * 1024, body.byteLength));
        offset += next.byteLength;
        controller.enqueue(next);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": encoded.headers.get("content-type")! },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const before = await readdir(tmpdir());

    await expect(streamDocumentUploadMultipart(request)).rejects.toMatchObject({
      message: "The multipart upload exceeds the configured size limit.",
    });
    expect(cancelled).toBe(true);
    expect(await leakedUploadTempDirs(before)).toEqual([]);
  });

  it("streams a bounded multipart upload to a removable private temp directory", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "4096";
    const payload = "small document";
    const upload = await streamDocumentUploadMultipart(multipartRequest(new TextEncoder().encode(payload)));
    try {
      expect(upload.files).toHaveLength(1);
      expect(upload.files[0]).toMatchObject({ originalFileName: "sample.txt", byteSize: 14 });
      expect(upload.files[0].contentSha256).toBe(createHash("sha256").update(payload).digest("hex"));
      expect(upload.fields.scope).toContain('"projectId":"p"');
    } finally {
      await removeStreamedDocumentMultipart(upload);
    }
  });
});

import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import Busboy from "busboy";

import { assertDocumentUploadSize, getDocumentMaxUploadBytes } from "./document-upload-validation";
import { DocumentParseError } from "./parsed-document.types";

const MAX_MULTIPART_FILES = 20;
const MAX_MULTIPART_FIELDS = 20;
const MAX_MULTIPART_FIELD_BYTES = 64 * 1024;

export type StreamedDocumentUpload = {
  fieldName: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  contentSha256: string;
  tempPath: string;
};

export type StreamedDocumentMultipart = {
  fields: Record<string, string>;
  files: StreamedDocumentUpload[];
  tempDirectory: string;
};

/**
 * Streams multipart bytes directly to a per-request temp directory while hashing
 * and enforcing the configured cap. The route later validates magic bytes and
 * moves accepted files into the content-addressed storage backend. This avoids the
 * `request.formData()` / `arrayBuffer()` whole-upload memory spike.
 */
export async function streamDocumentUploadMultipart(request: Request): Promise<StreamedDocumentMultipart> {
  const maxUploadBytes = getDocumentMaxUploadBytes();
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) throw new Error("The upload Content-Length is invalid.");
    assertDocumentUploadSize(declared, maxUploadBytes);
  }
  if (!request.body) throw new Error("The upload body is required.");

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    throw new Error("Document uploads must use multipart/form-data.");
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "itestflow-document-upload-"));
  try {
    const parsed = await parseMultipart({ request, tempDirectory, maxUploadBytes });
    if (!parsed.fields.scope?.trim()) throw new Error("The upload must include a project scope before file data.");
    if (!parsed.files.length) throw new Error("Select at least one document to upload.");
    return { ...parsed, tempDirectory };
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeStreamedDocumentMultipart(upload: Pick<StreamedDocumentMultipart, "tempDirectory">) {
  await rm(upload.tempDirectory, { recursive: true, force: true });
}

async function parseMultipart(input: {
  request: Request;
  tempDirectory: string;
  maxUploadBytes: number;
}): Promise<Omit<StreamedDocumentMultipart, "tempDirectory">> {
  const fields: Record<string, string> = {};
  const files: StreamedDocumentUpload[] = [];
  const fileTasks: Promise<void>[] = [];
  let filesStarted = false;
  let failure: Error | null = null;
  const source = Readable.fromWeb(input.request.body! as import("node:stream/web").ReadableStream);
  // Content-Length is optional for streamed/chunked requests. Count the actual
  // multipart bytes as well so a client cannot turn the per-file Busboy limit
  // into a 20-file (1 GiB) request merely by omitting that header.
  const byteLimitedSource = createMultipartByteLimitTransform(input.maxUploadBytes);
  const parser = Busboy({
    headers: Object.fromEntries(input.request.headers.entries()),
    limits: {
      files: MAX_MULTIPART_FILES,
      fields: MAX_MULTIPART_FIELDS,
      fieldSize: MAX_MULTIPART_FIELD_BYTES,
      fileSize: input.maxUploadBytes,
    },
  });

  const fail = (error: unknown) => {
    if (!failure) failure = error instanceof Error ? error : new Error("Unable to parse document upload.");
  };

  parser.on("field", (name, value, info) => {
    if (info.valueTruncated) {
      fail(new Error(`The ${name} field is too large.`));
      return;
    }
    if (name === "scope" && filesStarted) {
      fail(new Error("The project scope must appear before file data."));
      return;
    }
    // Keep the first value for every key. Repeated metadata fields are rejected at
    // the route schema rather than silently letting a later value rewrite scope.
    if (!(name in fields)) fields[name] = value;
  });
  parser.on("file", (fieldName, file, info) => {
    filesStarted = true;
    if (!fields.scope?.trim()) {
      file.resume();
      fail(new Error("The project scope must appear before file data."));
      return;
    }
    if (fieldName !== "files") {
      file.resume();
      fail(new Error("Unexpected multipart file field."));
      return;
    }
    const task = streamOneFile({
      file,
      originalFileName: info.filename,
      mimeType: info.mimeType,
      tempDirectory: input.tempDirectory,
      maxUploadBytes: input.maxUploadBytes,
    }).then((uploaded) => {
      files.push({ fieldName, ...uploaded });
    });
    fileTasks.push(task.catch((error) => {
      fail(error);
    }));
  });
  parser.on("filesLimit", () => fail(new Error(`No more than ${MAX_MULTIPART_FILES} documents can be uploaded at once.`)));
  parser.on("fieldsLimit", () => fail(new Error("Too many multipart fields.")));
  parser.on("partsLimit", () => fail(new Error("The multipart upload contains too many parts.")));

  await new Promise<void>((resolve, reject) => {
    parser.once("error", reject);
    source.once("error", reject);
    byteLimitedSource.once("error", reject);
    parser.once("close", resolve);
    source.pipe(byteLimitedSource).pipe(parser);
  });
  await Promise.all(fileTasks);
  if (failure) throw failure;
  return { fields, files };
}

function createMultipartByteLimitTransform(maxBytes: number) {
  let byteSize = 0;
  return new Transform({
    transform(chunk: Buffer | Uint8Array | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > maxBytes) {
        callback(new DocumentParseError({
          code: "oversized",
          message: "The multipart upload exceeds the configured size limit.",
        }));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function streamOneFile(input: {
  file: Readable;
  originalFileName: string;
  mimeType: string;
  tempDirectory: string;
  maxUploadBytes: number;
}): Promise<Omit<StreamedDocumentUpload, "fieldName">> {
  const tempPath = join(input.tempDirectory, `${randomUUID()}.upload`);
  const output = createWriteStream(tempPath, { flags: "wx" });
  const hash = createHash("sha256");
  let byteSize = 0;
  let exceeded = false;
  input.file.on("data", (chunk: Buffer) => {
    byteSize += chunk.byteLength;
    if (byteSize > input.maxUploadBytes) {
      exceeded = true;
      input.file.destroy(new Error("The upload exceeds the configured size limit."));
      return;
    }
    hash.update(chunk);
  });
  input.file.on("limit", () => {
    exceeded = true;
    input.file.destroy(new Error("The upload exceeds the configured size limit."));
  });
  // pipe() does not propagate a source error/destroy to its destination, so
  // without this the write stream — and the fd + temp file behind it — would
  // stay open forever whenever an oversized upload destroys the source
  // mid-stream, leaking a locked temp file (and, on Windows, breaking the
  // caller's later recursive rm of the whole request temp directory).
  input.file.on("error", () => {
    if (!output.destroyed) output.destroy();
  });
  input.file.pipe(output);
  try {
    await Promise.all([finished(input.file), finished(output)]);
  } catch (error) {
    await destroyWriteStream(output);
    await rm(tempPath, { force: true });
    throw error;
  }
  if (exceeded) {
    await destroyWriteStream(output);
    await rm(tempPath, { force: true });
    assertDocumentUploadSize(byteSize, input.maxUploadBytes);
    throw new Error("The upload exceeds the configured size limit.");
  }
  return {
    originalFileName: input.originalFileName || "upload",
    mimeType: input.mimeType || "application/octet-stream",
    byteSize,
    contentSha256: hash.digest("hex"),
    tempPath,
  };
}

/**
 * Force-close a write stream and await the underlying fd release before the
 * caller unlinks its temp file. destroy() alone is not enough: it emits
 * 'close' asynchronously, and unlinking before that fires can fail (locked
 * file) on Windows and leave both the fd and the temp file behind.
 */
async function destroyWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (stream.destroyed) return;
  await new Promise<void>((resolve) => {
    stream.once("close", () => resolve());
    stream.destroy();
  });
}

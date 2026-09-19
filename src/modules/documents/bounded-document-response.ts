import "server-only";

import { assertDocumentUploadSize, getDocumentMaxUploadBytes } from "./document-upload-validation";

/**
 * Buffers an upstream document response only after checking both its advertised
 * size and every streamed chunk against the deployment upload cap.
 */
export async function readBoundedDocumentResponse(response: Response): Promise<ArrayBuffer> {
  const maxUploadBytes = getDocumentMaxUploadBytes();
  try {
    assertResponseContentLength(response.headers.get("content-length"), maxUploadBytes);
  } catch (error) {
    await cancelStream(response.body);
    throw error;
  }

  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      byteLength += value.byteLength;
      assertDocumentUploadSize(byteLength, maxUploadBytes);
      chunks.push(value);
    }
  } catch (error) {
    await cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const content = new ArrayBuffer(byteLength);
  const destination = new Uint8Array(content);
  let offset = 0;
  for (const chunk of chunks) {
    destination.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function assertResponseContentLength(contentLength: string | null, maxUploadBytes: number) {
  const normalized = contentLength?.trim().replace(/^0+(?=\d)/, "");
  if (!normalized || !/^\d+$/.test(normalized)) return;

  const limit = String(maxUploadBytes);
  if (normalized.length > limit.length || (normalized.length === limit.length && normalized > limit)) {
    assertDocumentUploadSize(maxUploadBytes + 1, maxUploadBytes);
  }
}

async function cancelStream(stream: ReadableStream<Uint8Array> | null) {
  try {
    await stream?.cancel();
  } catch {
    // Preserve the original validation error when an upstream stream cannot be cancelled.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    await reader.cancel();
  } catch {
    // Preserve the original stream or validation error.
  }
}

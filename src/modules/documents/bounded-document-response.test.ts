import { afterEach, describe, expect, it } from "vitest";

import { DocumentParseError } from "./parsed-document.types";
import { readBoundedDocumentResponse } from "./bounded-document-response";

const ORIGINAL_UPLOAD_LIMIT = process.env.DOCUMENT_MAX_UPLOAD_BYTES;

afterEach(() => {
  if (ORIGINAL_UPLOAD_LIMIT === undefined) delete process.env.DOCUMENT_MAX_UPLOAD_BYTES;
  else process.env.DOCUMENT_MAX_UPLOAD_BYTES = ORIGINAL_UPLOAD_LIMIT;
});

describe("readBoundedDocumentResponse", () => {
  it("returns an exact ArrayBuffer for a bounded streamed response", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "8";
    const response = new Response(streamFromChunks([new Uint8Array([1, 2]), new Uint8Array([3])]), {
      headers: { "content-length": "3" },
    });

    const content = await readBoundedDocumentResponse(response);

    expect(content).toBeInstanceOf(ArrayBuffer);
    expect(content.byteLength).toBe(3);
    expect([...new Uint8Array(content)]).toEqual([1, 2, 3]);
  });

  it("rejects an oversized Content-Length before reading the response stream", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "3";
    let pulls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 }), { headers: { "content-length": "4" } });

    await expect(readBoundedDocumentResponse(response)).rejects.toMatchObject({
      code: "oversized",
    } satisfies Partial<DocumentParseError>);
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("cancels a response whose streamed bytes exceed the configured cap", async () => {
    process.env.DOCUMENT_MAX_UPLOAD_BYTES = "3";
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    }));

    await expect(readBoundedDocumentResponse(response)).rejects.toMatchObject({
      code: "oversized",
    } satisfies Partial<DocumentParseError>);
    expect(cancelled).toBe(true);
  });
});

function streamFromChunks(chunks: readonly Uint8Array[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

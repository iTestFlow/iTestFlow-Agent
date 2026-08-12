import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  createImageDocumentParser,
  createLocalOcrWorker,
  type OcrRecognition,
  type OcrModelSpec,
  type TesseractWorkerCreator,
  type OcrWorkerPort,
} from "./image-document.parser";

const bytes = new Uint8Array([1, 2, 3]);

function workerFor(recognition: OcrRecognition): OcrWorkerPort {
  return {
    recognize: vi.fn(async () => recognition),
    terminate: vi.fn(async () => undefined),
  };
}

function recognition(blocks: OcrRecognition["blocks"], confidence = 90): OcrRecognition {
  return { blocks, confidence, text: blocks?.map((block) => block.text).join("\n") ?? "", version: "7.0.0" };
}

describe("image document parser", () => {
  it.each([
    [undefined, "eng"], ["", "eng"], ["en", "eng"], ["ENG", "eng"], ["English", "eng"],
    ["ar", "ara"], ["ARA", "ara"], ["Arabic", "ara"], ["العربية", "ara"],
  ])("maps language hint %j to local OCR language %s", async (languageHint, expected) => {
    const worker = workerFor(recognition([{ text: "Text", confidence: 90, bbox: { x0: 1, y0: 2, x1: 30, y1: 20 } }]));
    const createWorker = vi.fn(async () => worker);
    const parser = createImageDocumentParser("png", { createWorker });

    await parser.parse({ data: bytes, languageHint });

    expect(createWorker).toHaveBeenCalledWith(expected);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("configures Tesseract with bundled traineddata and no remote cache", async () => {
    const worker = workerFor(recognition([]));
    const creator = vi.fn<TesseractWorkerCreator>(async () => worker);

    await createLocalOcrWorker("ara", creator);

    expect(creator).toHaveBeenCalledWith("ara", expect.anything(), expect.objectContaining({
      cacheMethod: "none",
      errorHandler: expect.any(Function),
      gzip: true,
      langPath: expect.any(String),
    }));
    const options = creator.mock.calls[0][2];
    expect(path.isAbsolute(options.langPath)).toBe(true);
    expect(options.langPath).not.toMatch(/^https?:/i);
  });

  it("rejects a pending local worker when Tesseract reports unreadable bundled language data", async () => {
    const creator = vi.fn<TesseractWorkerCreator>((_language, _oem, options) => {
      options.errorHandler(new Error("traineddata unreadable"));
      return new Promise<OcrWorkerPort>(() => undefined);
    });

    await expect(createLocalOcrWorker("eng", creator)).rejects.toThrow(/traineddata unreadable/i);
  });

  it("terminates exactly once when the raw Tesseract creator resolves after reporting a startup error", async () => {
    let resolveWorker!: (worker: OcrWorkerPort) => void;
    const worker = workerFor(recognition([]));
    const creator = vi.fn<TesseractWorkerCreator>((_language, _oem, options) => {
      options.errorHandler(new Error("traineddata unreadable"));
      return new Promise<OcrWorkerPort>((resolve) => { resolveWorker = resolve; });
    });
    const startup = createLocalOcrWorker("eng", creator);

    await expect(startup).rejects.toThrow(/traineddata unreadable/i);
    expect(worker.terminate).not.toHaveBeenCalled();
    resolveWorker(worker);

    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  });

  it.each(["missing", "corrupt_gzip", "hash_mismatch"] as const)(
    "rejects a %s bundled model before spawning a MessagePort",
    async (failure) => {
      const directory = await mkdtemp(path.join(tmpdir(), "itf-ocr-model-"));
      const modelPath = path.join(directory, "eng.traineddata.gz");
      const decoded = Buffer.alloc(1024, 7);
      const validGzip = gzipSync(decoded);
      const contents = failure === "corrupt_gzip" ? Buffer.from("not gzip") : validGzip;
      if (failure !== "missing") await writeFile(modelPath, contents);
      const expectedSha256 = failure === "hash_mismatch"
        ? "0".repeat(64)
        : createHash("sha256").update(contents).digest("hex");
      const model: OcrModelSpec = { langPath: directory, gzip: true, expectedSha256, minDecodedBytes: 100 };
      const createWorker = vi.fn<TesseractWorkerCreator>();
      const handlesBefore = activeMessagePortCount();

      try {
        await expect(createLocalOcrWorker("eng", createWorker, model)).rejects.toThrow(/OCR language data/i);
        expect(createWorker).not.toHaveBeenCalled();
        expect(activeMessagePortCount()).toBe(handlesBefore);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("revalidates a previously valid model path before every worker startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "itf-ocr-model-revalidate-"));
    const modelPath = path.join(directory, "eng.traineddata.gz");
    const compressed = gzipSync(Buffer.alloc(1024, 7));
    await writeFile(modelPath, compressed);
    const model: OcrModelSpec = {
      langPath: directory,
      gzip: true,
      expectedSha256: createHash("sha256").update(compressed).digest("hex"),
      minDecodedBytes: 100,
    };
    const firstWorker = workerFor(recognition([]));
    const creator = vi.fn<TesseractWorkerCreator>(async () => firstWorker);

    try {
      const started = await createLocalOcrWorker("eng", creator, model);
      await started.terminate();
      await writeFile(modelPath, Buffer.from("corrupt after validation"));
      creator.mockClear();
      const handlesBefore = activeMessagePortCount();

      await expect(createLocalOcrWorker("eng", creator, model)).rejects.toThrow(/OCR language data/i);
      expect(creator).not.toHaveBeenCalled();
      expect(activeMessagePortCount()).toBe(handlesBefore);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits stable OCR regions with bbox, confidence, language, and engine provenance", async () => {
    const worker = workerFor(recognition([
      { text: " First region ", confidence: 91, bbox: { x0: 1, y0: 2, x1: 40, y1: 20 } },
      { text: "Second region", confidence: 82, bbox: { x0: 2, y0: 24, x1: 45, y1: 42 } },
    ], 87));
    const parser = createImageDocumentParser("jpeg", { createWorker: async () => worker });

    const result = await parser.parse({ data: bytes, languageHint: "en" });

    expect(result.status).toBe("parsed");
    expect(result.sections).toEqual([
      { sectionKey: "ocr-region-1", kind: "ocr_region", text: "First region", metadata: { bbox: { x0: 1, y0: 2, x1: 40, y1: 20 }, confidence: 91, language: "eng" } },
      { sectionKey: "ocr-region-2", kind: "ocr_region", text: "Second region", metadata: { bbox: { x0: 2, y0: 24, x1: 45, y1: 42 }, confidence: 82, language: "eng" } },
    ]);
    expect(result.documentMetadata.ocr).toEqual(expect.objectContaining({
      engine: "tesseract.js", engineVersion: "7.0.0", language: "eng", confidence: 87,
      status: "parsed", acceptedRegionCount: 2, rejectedRegionCount: 0,
    }));
  });

  it("excludes low-confidence regions while retaining diagnostic metadata and a warning", async () => {
    const worker = workerFor(recognition([
      { text: "uncertain", confidence: 39, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
      { text: "certain", confidence: 88, bbox: { x0: 0, y0: 12, x1: 10, y1: 22 } },
    ]));
    const parser = createImageDocumentParser("webp", { createWorker: async () => worker, minConfidence: 50 });

    const result = await parser.parse({ data: bytes });

    expect(result.status).toBe("partially_parsed");
    expect(result.sections.map((section) => section.sectionKey)).toEqual(["ocr-region-2"]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "low_confidence", metadata: { minConfidence: 50, rejectedRegionCount: 1 } })]);
    expect(result.documentMetadata.ocr).toEqual(expect.objectContaining({ status: "partially_parsed", acceptedRegionCount: 1, rejectedRegionCount: 1 }));
  });

  it("reports no text without inventing a section", async () => {
    const worker = workerFor(recognition([], 0));
    const parser = createImageDocumentParser("png", { createWorker: async () => worker });

    const result = await parser.parse({ data: bytes });

    expect(result).toMatchObject({ status: "empty", sections: [], warnings: [{ code: "no_extractable_text" }] });
    expect(result.documentMetadata.ocr).toEqual(expect.objectContaining({ status: "no_text", acceptedRegionCount: 0 }));
  });

  it("fails safely for an unsupported language hint before creating a worker", async () => {
    const createWorker = vi.fn();
    const parser = createImageDocumentParser("png", { createWorker });

    await expect(parser.parse({ data: bytes, languageHint: "fr" })).rejects.toMatchObject({ code: "unsupported_format" });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("terminates a worker when recognition fails", async () => {
    const worker: OcrWorkerPort = {
      recognize: vi.fn(async () => { throw new Error("OCR exploded"); }),
      terminate: vi.fn(async () => undefined),
    };
    const parser = createImageDocumentParser("png", { createWorker: async () => worker });

    await expect(parser.parse({ data: bytes })).rejects.toMatchObject({ code: "corrupted" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("maps worker startup failure to a safe parse error", async () => {
    const parser = createImageDocumentParser("png", { createWorker: async () => { throw new Error("startup failed"); } });

    await expect(parser.parse({ data: bytes })).rejects.toMatchObject({ code: "corrupted" });
  });

  it("maps worker termination failure to a safe parse error", async () => {
    const worker = workerFor(recognition([{ text: "Text", confidence: 90, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }]));
    vi.mocked(worker.terminate).mockRejectedValueOnce(new Error("terminate failed"));
    const parser = createImageDocumentParser("png", { createWorker: async () => worker });

    await expect(parser.parse({ data: bytes })).rejects.toMatchObject({ code: "corrupted" });
  });

  it("terminates and returns cancelled when the signal aborts during recognition", async () => {
    const worker: OcrWorkerPort = {
      recognize: vi.fn(() => new Promise<OcrRecognition>(() => undefined)),
      terminate: vi.fn(async () => undefined),
    };
    const parser = createImageDocumentParser("png", { createWorker: async () => worker });
    const controller = new AbortController();
    const result = parser.parse({ data: bytes, signal: controller.signal });

    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("does not create a worker when already cancelled", async () => {
    const createWorker = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(createImageDocumentParser("png", { createWorker }).parse({ data: bytes, signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("rejects promptly when aborted during worker startup and cleans up a worker that resolves late", async () => {
    let resolveWorker!: (worker: OcrWorkerPort) => void;
    const worker = workerFor(recognition([]));
    const createWorker = vi.fn(() => new Promise<OcrWorkerPort>((resolve) => { resolveWorker = resolve; }));
    const controller = new AbortController();
    const parse = createImageDocumentParser("png", { createWorker }).parse({ data: bytes, signal: controller.signal });

    controller.abort();

    const outcome = await Promise.race([
      parse.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ]);
    expect(outcome).toMatchObject({ code: "cancelled" });

    resolveWorker(worker);
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    await expect(parse).rejects.toMatchObject({ code: "cancelled" });
  });

  it("preserves cancellation when the worker factory aborts synchronously before the startup wait", async () => {
    const controller = new AbortController();
    const worker = workerFor(recognition([]));
    let resolveWorker!: (worker: OcrWorkerPort) => void;
    const createWorker = vi.fn(() => {
      controller.abort();
      return new Promise<OcrWorkerPort>((resolve) => { resolveWorker = resolve; });
    });

    await expect(createImageDocumentParser("png", { createWorker, workerStartupTimeoutMs: 20 })
      .parse({ data: bytes, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    resolveWorker(worker);
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  });

  it("bounds worker startup time and cleans up a worker that resolves after timeout", async () => {
    let resolveWorker!: (worker: OcrWorkerPort) => void;
    const worker = workerFor(recognition([]));
    const createWorker = vi.fn(() => new Promise<OcrWorkerPort>((resolve) => { resolveWorker = resolve; }));
    const parse = createImageDocumentParser("png", { createWorker, workerStartupTimeoutMs: 20 }).parse({ data: bytes });

    await expect(parse).rejects.toMatchObject({ code: "corrupted", message: expect.stringMatching(/start.*time/i) });
    resolveWorker(worker);
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  });

  it.each([
    ["eng" as const, "LOCAL OCR", "LOCAL OCR"],
    ["ara" as const, "مرحبا", "مرحبا"],
  ])("recognizes a small real %s image with bundled traineddata", async (language, visibleText, expectedText) => {
    const image = await sharp(Buffer.from(
      `<svg width="640" height="140" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="320" y="95" text-anchor="middle" direction="${language === "ara" ? "rtl" : "ltr"}" font-family="DejaVu Sans" font-size="64" fill="black">${visibleText}</text></svg>`,
    )).png().toBuffer();

    const result = await createImageDocumentParser("png", { minConfidence: 20 }).parse({ data: image, languageHint: language });

    expect(result.sections.map((section) => section.text).join(" ")).toContain(expectedText);
  }, 30_000);
});

function activeMessagePortCount() {
  const getActiveHandles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles;
  return getActiveHandles.call(process).filter((handle) => (handle as { constructor?: { name?: string } }).constructor?.name === "MessagePort").length;
}

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import Tesseract from "tesseract.js";

import type { DocumentFormat, DocumentParseInput, DocumentParser, ParsedDocumentSection } from "../parsed-document.types";
import { DocumentParseError, isDocumentParseError } from "../parsed-document.types";
import {
  assertNotAborted,
  assertWithinExtractedTextLimit,
  createNoTextWarning,
  createParsedDocument,
  normalizeExtractedText,
} from "./parser-utils";

export type ImageDocumentFormat = Extract<DocumentFormat, "png" | "jpeg" | "webp">;
export type OcrLanguage = "eng" | "ara";
export type OcrRegion = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
export type OcrRecognition = { blocks: OcrRegion[] | null; confidence: number; text: string; version: string };
export type OcrWorkerPort = {
  recognize(data: Uint8Array): Promise<OcrRecognition>;
  terminate(): Promise<unknown>;
};
export type OcrWorkerFactory = (language: OcrLanguage) => Promise<OcrWorkerPort>;
type LocalWorkerOptions = { cacheMethod: string; errorHandler: (error: unknown) => void; gzip: boolean; langPath: string };
export type TesseractWorkerCreator = (language: string, oem: unknown, options: LocalWorkerOptions) => Promise<OcrWorkerPort>;
export type OcrModelSpec = { langPath: string; gzip: true; expectedSha256: string; minDecodedBytes: number };

const require = createRequire(import.meta.url);
// SHA-256 values pin the exact @tesseract.js-data/{eng,ara}@1.0.0 4.0.0
// payloads declared in package.json. Validate before Tesseract spawns a worker.
const TRAINED_DATA: Record<OcrLanguage, OcrModelSpec> = {
  eng: { ...(require("@tesseract.js-data/eng") as { langPath: string }), gzip: true, expectedSha256: "ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468", minDecodedBytes: 1_000_000 },
  ara: { ...(require("@tesseract.js-data/ara") as { langPath: string }), gzip: true, expectedSha256: "400ab30fe4f4c4a03feeabe0779a7122cee6aa4fffb1629bb5b1671942859c9e", minDecodedBytes: 1_000_000 },
};
const DEFAULT_MIN_CONFIDENCE = 50;
const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_RECOGNIZE_TIMEOUT_MS = 120_000;

export async function createLocalOcrWorker(
  language: OcrLanguage,
  creator: TesseractWorkerCreator = createTesseractWorker,
  model: OcrModelSpec = TRAINED_DATA[language],
) {
  await validateOcrModel(language, model);
  let rejectReportedError!: (error: unknown) => void;
  let didReportError = false;
  const reportedError = new Promise<never>((_resolve, reject) => { rejectReportedError = reject; });
  const worker = creator(language, Tesseract.OEM.LSTM_ONLY, {
    cacheMethod: "none",
    // Tesseract can report a traineddata failure here while leaving the
    // createWorker promise pending. Convert that callback into a rejection.
    errorHandler: (error) => {
      didReportError = true;
      rejectReportedError(error instanceof Error ? error : new Error(String(error)));
    },
    gzip: model.gzip,
    langPath: model.langPath,
  });
  try {
    return await Promise.race([worker, reportedError]);
  } catch (cause) {
    // The adapter's raced promise no longer exposes a raw creator that resolves
    // after errorHandler fires, so release that late worker at this boundary.
    if (didReportError) void worker.then((lateWorker) => lateWorker.terminate()).catch(() => undefined);
    throw cause;
  }
}

async function validateOcrModel(language: OcrLanguage, model: OcrModelSpec) {
  const modelPath = path.join(model.langPath, `${language}.traineddata.gz`);
  try {
    const details = await stat(modelPath);
    if (!details.isFile()) throw new Error("not a regular file");
    const compressed = await readFile(modelPath);
    const actualHash = createHash("sha256").update(compressed).digest("hex");
    if (actualHash !== model.expectedSha256) throw new Error("SHA-256 mismatch");
    const decoded = gunzipSync(compressed);
    if (decoded.byteLength < model.minDecodedBytes) throw new Error("decoded payload is unexpectedly small");
  } catch (cause) {
    throw new Error(`OCR language data for ${language} is missing, unreadable, or invalid.`, { cause });
  }
}

export function createImageDocumentParser(
  format: ImageDocumentFormat,
  dependencies: { createWorker?: OcrWorkerFactory; minConfidence?: number; workerStartupTimeoutMs?: number; recognizeTimeoutMs?: number } = {},
): DocumentParser {
  const createWorker = dependencies.createWorker ?? createLocalOcrWorker;
  const minConfidence = resolveMinConfidence(dependencies.minConfidence);
  const workerStartupTimeoutMs = dependencies.workerStartupTimeoutMs ?? DEFAULT_WORKER_STARTUP_TIMEOUT_MS;
  const recognizeTimeoutMs = dependencies.recognizeTimeoutMs ?? resolveRecognizeTimeoutMs();
  return {
    format,
    async parse(input: DocumentParseInput) {
      assertNotAborted(input.signal);
      const language = resolveLanguage(input.languageHint);
      let worker: OcrWorkerPort;
      const workerStartup = createWorker(language);
      try {
        worker = await waitForWorkerStartup(workerStartup, input.signal, workerStartupTimeoutMs);
      } catch (cause) {
        // The underlying factory cannot be forcibly cancelled. If it settles
        // after this parse has stopped waiting, release its worker immediately.
        void workerStartup.then((lateWorker) => lateWorker.terminate()).catch(() => undefined);
        if (isDocumentParseError(cause)) throw cause;
        throw new DocumentParseError({ code: "corrupted", message: "The local OCR worker could not be started.", cause });
      }
      let recognition: OcrRecognition;
      let recognitionFailure: unknown;
      try {
        assertNotAborted(input.signal);
        recognition = await recognizeUntilAbort(worker, input, recognizeTimeoutMs);
      } catch (cause) {
        recognitionFailure = isDocumentParseError(cause)
          ? cause
          : new DocumentParseError({ code: "corrupted", message: "The image could not be read by the local OCR engine.", cause });
        throw recognitionFailure;
      } finally {
        try {
          await worker.terminate();
        } catch (cause) {
          if (!recognitionFailure) {
            throw new DocumentParseError({ code: "corrupted", message: "The local OCR worker could not be terminated cleanly.", cause });
          }
        }
      }

      assertNotAborted(input.signal);
      const blocks = recognition.blocks ?? [];
      const sections: ParsedDocumentSection[] = [];
      let rejectedRegionCount = 0;
      for (const [index, block] of blocks.entries()) {
        const text = normalizeExtractedText(block.text);
        if (!text) continue;
        if (block.confidence < minConfidence) {
          rejectedRegionCount += 1;
          continue;
        }
        sections.push({
          sectionKey: `ocr-region-${index + 1}`,
          kind: "ocr_region",
          text,
          metadata: { bbox: block.bbox, confidence: block.confidence, language },
        });
      }
      const extractedText = sections.map((section) => section.text).join("\n");
      assertWithinExtractedTextLimit(extractedText, input.maxExtractedTextChars);

      const hasAcceptedText = sections.length > 0;
      const status = hasAcceptedText && rejectedRegionCount > 0 ? "partially_parsed" : hasAcceptedText ? "parsed" : "empty";
      const ocrStatus = hasAcceptedText && rejectedRegionCount > 0
        ? "partially_parsed"
        : hasAcceptedText
          ? "parsed"
          : rejectedRegionCount > 0
            ? "low_confidence"
            : "no_text";
      const warnings = rejectedRegionCount > 0
        ? [{
            code: "low_confidence" as const,
            message: `${rejectedRegionCount.toLocaleString()} OCR region(s) were below the confidence threshold and were not indexed.`,
            metadata: { minConfidence, rejectedRegionCount },
          }]
        : hasAcceptedText
          ? []
          : [createNoTextWarning("No text was detected in this image by local OCR.")];

      return createParsedDocument({
        format,
        sections,
        warnings,
        status,
        metadata: {
          ocr: {
            engine: "tesseract.js",
            engineVersion: recognition.version,
            language,
            confidence: recognition.confidence,
            status: ocrStatus,
            minConfidence,
            acceptedRegionCount: sections.length,
            rejectedRegionCount,
          },
        },
      });
    },
  };
}

async function createTesseractWorker(language: string, oem: unknown, options: LocalWorkerOptions): Promise<OcrWorkerPort> {
  const worker = await Tesseract.createWorker(language, oem as Tesseract.OEM, options);
  return {
    async recognize(data) {
      const result = await worker.recognize(Buffer.from(data), {}, { text: true, blocks: true });
      return {
        blocks: result.data.blocks?.map((block) => ({ text: block.text, confidence: block.confidence, bbox: block.bbox })) ?? null,
        confidence: result.data.confidence,
        text: result.data.text,
        version: result.data.version,
      };
    },
    terminate: () => worker.terminate(),
  };
}

function resolveLanguage(hint?: string | null): OcrLanguage {
  const normalized = hint?.trim().toLocaleLowerCase("en") ?? "";
  if (!normalized || ["en", "eng", "english"].includes(normalized)) return "eng";
  if (["ar", "ara", "arabic", "العربية"].includes(normalized)) return "ara";
  throw new DocumentParseError({
    code: "unsupported_format",
    message: `Image OCR supports only English or Arabic; “${hint}” is not supported.`,
  });
}

function resolveMinConfidence(value?: number) {
  const candidate = value ?? Number(process.env.OCR_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE);
  return Number.isFinite(candidate) && candidate >= 0 && candidate <= 100 ? candidate : DEFAULT_MIN_CONFIDENCE;
}

export function resolveRecognizeTimeoutMs(environment = process.env) {
  const candidate = Number(environment.OCR_RECOGNIZE_TIMEOUT_MS ?? DEFAULT_RECOGNIZE_TIMEOUT_MS);
  return Number.isSafeInteger(candidate) && candidate >= 1_000 && candidate <= 600_000
    ? candidate
    : DEFAULT_RECOGNIZE_TIMEOUT_MS;
}

async function recognizeUntilAbort(worker: OcrWorkerPort, input: DocumentParseInput, timeoutMs: number) {
  const signal = input.signal;
  if (signal?.aborted) throw cancelledError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: () => void = () => undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new DocumentParseError({
      code: "corrupted",
      message: "The local OCR engine did not finish within the permitted time.",
    })), Math.max(1, timeoutMs));
  });
  const abortPromise = signal ? new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  }) : new Promise<never>(() => undefined);
  try {
    return await Promise.race([worker.recognize(input.data), abortPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener();
  }
}

async function waitForWorkerStartup(startup: Promise<OcrWorkerPort>, signal: AbortSignal | undefined, timeoutMs: number) {
  if (signal?.aborted) throw cancelledError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: () => void = () => undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new DocumentParseError({
      code: "corrupted",
      message: "The local OCR worker did not start within the permitted time.",
    })), Math.max(1, timeoutMs));
  });
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(cancelledError());
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        // Close the gap between the precheck and listener registration.
        if (signal.aborted) onAbort();
      })
    : new Promise<never>(() => undefined);
  try {
    return await Promise.race([startup, abortPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener();
  }
}

function cancelledError() {
  return new DocumentParseError({ code: "cancelled", message: "Document parsing was cancelled." });
}

export const pngDocumentParser = createImageDocumentParser("png");
export const jpegDocumentParser = createImageDocumentParser("jpeg");
export const webpDocumentParser = createImageDocumentParser("webp");

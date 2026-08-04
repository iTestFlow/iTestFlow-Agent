import {
  type DocumentFormat,
  DocumentParseError,
  type ParsedDocument,
  type ParsedDocumentMetadata,
  type ParsedDocumentSection,
  type ParsedDocumentStatus,
  type ParsedDocumentWarning,
} from "../parsed-document.types";

/** The parsed-text cap from the architecture plan (5 MiB of JS characters). */
export const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 5 * 1024 * 1024;

/** A hard ceiling prevents an accidental caller override from disabling the cap. */
export const ABSOLUTE_MAX_EXTRACTED_TEXT_CHARS = 10 * 1024 * 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];

export function resolveExtractedTextLimit(requested?: number) {
  if (requested === undefined) return DEFAULT_MAX_EXTRACTED_TEXT_CHARS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_EXTRACTED_TEXT_CHARS;
  return Math.min(Math.floor(requested), ABSOLUTE_MAX_EXTRACTED_TEXT_CHARS);
}

/**
 * Decode only UTF-8 and BOM-marked UTF-16 text. Supporting a small explicit set
 * avoids treating arbitrary binary data as text while still handling common
 * Windows exports.
 */
export function decodeTextBytes(data: Uint8Array) {
  const encoding = detectTextEncoding(data);
  try {
    const offset = encoding === "utf-8" && hasPrefix(data, UTF8_BOM) ? UTF8_BOM.length : encoding === "utf-16le" ? UTF16_LE_BOM.length : encoding === "utf-16be" ? UTF16_BE_BOM.length : 0;
    return new TextDecoder(encoding, { fatal: true }).decode(data.subarray(offset));
  } catch (cause) {
    throw new DocumentParseError({
      code: "corrupted",
      message: "The text file is not valid UTF-8 or BOM-marked UTF-16.",
      cause,
    });
  }
}

export function isDecodableText(data: Uint8Array) {
  try {
    decodeTextBytes(data);
    return true;
  } catch {
    return false;
  }
}

export function normalizeExtractedText(value: string) {
  // Keep the textual order exactly as the parser supplied it. Normalizing line
  // endings only makes locators and chunks deterministic across Windows/Linux.
  return value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

export function assertWithinExtractedTextLimit(text: string, requestedLimit?: number) {
  const limit = resolveExtractedTextLimit(requestedLimit);
  if (text.length <= limit) return;
  throw new DocumentParseError({
    code: "oversized",
    message: `Extracted text exceeds the ${limit.toLocaleString()} character safety limit.`,
  });
}

export function assertNotAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new DocumentParseError({
    code: "cancelled",
    message: "Document parsing was cancelled.",
  });
}

export function createParsedDocument(input: {
  format: DocumentFormat;
  sections: ParsedDocumentSection[];
  warnings?: ParsedDocumentWarning[];
  status?: ParsedDocumentStatus;
  metadata?: Omit<ParsedDocumentMetadata, "format" | "extractedTextChars">;
}): ParsedDocument {
  const sections = input.sections.filter((section) => section.text.trim().length > 0);
  const extractedTextChars = sections.reduce((total, section) => total + section.text.length, 0);
  const status = sections.length === 0 ? "empty" : (input.status ?? "parsed");

  return {
    status,
    sections,
    warnings: input.warnings ?? [],
    documentMetadata: {
      format: input.format,
      extractedTextChars,
      ...(input.metadata ?? {}),
    },
  };
}

export function createNoTextWarning(message = "No extractable text was found in this document."): ParsedDocumentWarning {
  return { code: "no_extractable_text", message };
}

/**
 * Groups plain paragraphs before they enter the generic chunker. This avoids
 * manufacturing thousands of tiny source sections while preserving a stable
 * paragraph-range locator for citations.
 */
export function paragraphSections(input: {
  text: string;
  sectionPrefix?: string;
  maxSectionChars?: number;
  metadata?: Record<string, unknown>;
}): ParsedDocumentSection[] {
  const normalized = normalizeExtractedText(input.text);
  if (!normalized) return [];

  const prefix = input.sectionPrefix ?? "paragraph";
  const maxSectionChars = input.maxSectionChars ?? 8_000;
  const paragraphs = normalized.split(/\n\s*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const sections: ParsedDocumentSection[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let paragraphStart = 1;
  let paragraphEnd = 0;

  const flush = () => {
    if (current.length === 0) return;
    const ordinal = sections.length + 1;
    sections.push({
      sectionKey: `${prefix}-${ordinal}`,
      kind: "paragraph",
      text: current.join("\n\n"),
      metadata: {
        ...(input.metadata ?? {}),
        paragraphStart,
        paragraphEnd,
      },
    });
    current = [];
    currentLength = 0;
  };

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const nextLength = currentLength === 0 ? paragraph.length : currentLength + 2 + paragraph.length;
    if (current.length > 0 && nextLength > maxSectionChars) {
      flush();
      paragraphStart = index + 1;
    }
    current.push(paragraph);
    currentLength = currentLength === 0 ? paragraph.length : currentLength + 2 + paragraph.length;
    paragraphEnd = index + 1;
  }
  flush();

  return sections;
}

function detectTextEncoding(data: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" {
  if (hasPrefix(data, UTF16_LE_BOM)) return "utf-16le";
  if (hasPrefix(data, UTF16_BE_BOM)) return "utf-16be";
  return "utf-8";
}

function hasPrefix(data: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => data[index] === value);
}

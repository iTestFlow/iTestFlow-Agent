/**
 * Parsed-document contracts are intentionally independent of persistence.  A
 * parser receives untrusted bytes and returns only plain text plus stable,
 * source-addressable locators.  The ingest handler can then turn each section
 * into RAG chunks without needing to understand any file-format details.
 */

export const DOCUMENT_FORMATS = ["pdf", "docx", "xlsx", "csv", "txt", "md", "png", "jpeg", "webp"] as const;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const PARSED_DOCUMENT_SECTION_KINDS = [
  "page",
  "slide",
  "sheet_range",
  "paragraph",
  "heading",
  "ocr_region",
  "vision_description",
  "user_description",
] as const;

export type ParsedDocumentSectionKind = (typeof PARSED_DOCUMENT_SECTION_KINDS)[number];

export type ParsedDocumentStatus = "parsed" | "partially_parsed" | "empty";

export const DOCUMENT_PARSE_ERROR_CODES = [
  "corrupted",
  "password_protected",
  "empty",
  "oversized",
  "unsupported_format",
  "cancelled",
] as const;

/**
 * These codes are deliberately stable: the ingest job uses them to decide
 * whether a failure is permanent rather than spending retries on the same
 * corrupt, password-protected, or unsupported bytes.
 */
export type DocumentParseErrorCode = (typeof DOCUMENT_PARSE_ERROR_CODES)[number];

export type ParsedDocumentWarningCode =
  | "no_extractable_text"
  | "page_parse_failed"
  | "sheet_limit_reached"
  | "cell_limit_reached"
  | "section_limit_reached"
  | "extracted_text_truncated"
  | "parser_message";

export type ParsedDocumentWarning = {
  code: ParsedDocumentWarningCode;
  message: string;
  sectionKey?: string;
  pageNumber?: number;
  metadata?: Record<string, unknown>;
};

export type ParsedDocumentSection = {
  /**
   * Stable, human-readable locator stored with chunks and citations. Examples:
   * `page-3`, `heading-release-notes`, and `sheet-Plan!A1:D40`.
   */
  sectionKey: string;
  kind: ParsedDocumentSectionKind;
  text: string;
  pageNumber?: number;
  metadata?: Record<string, unknown>;
};

export type ParsedDocumentMetadata = {
  format: DocumentFormat;
  extractedTextChars: number;
  pageCount?: number;
  parsedPageCount?: number;
  sheetCount?: number;
  parsedSheetCount?: number;
  [key: string]: unknown;
};

export type ParsedDocument = {
  status: ParsedDocumentStatus;
  sections: ParsedDocumentSection[];
  warnings: ParsedDocumentWarning[];
  documentMetadata: ParsedDocumentMetadata;
};

export type DocumentParseInput = {
  /** Raw uploaded bytes. Parsers must never execute, render, or persist them. */
  data: Uint8Array;
  /** Display metadata only; never use this value for a filesystem path. */
  fileName?: string;
  /** Lower this per call when a worker needs a tighter execution budget. */
  maxExtractedTextChars?: number;
  /** The worker's cancellation signal, checked at parser phase boundaries. */
  signal?: AbortSignal;
};

export interface DocumentParser {
  readonly format: DocumentFormat;
  parse(input: DocumentParseInput): Promise<ParsedDocument>;
}

export type DocumentParseErrorOptions = {
  code: DocumentParseErrorCode;
  message: string;
  cause?: unknown;
};

export class DocumentParseError extends Error {
  readonly code: DocumentParseErrorCode;

  constructor(options: DocumentParseErrorOptions) {
    super(options.message);
    this.name = "DocumentParseError";
    this.code = options.code;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return typeof value === "string" && DOCUMENT_FORMATS.includes(value as DocumentFormat);
}

export function isDocumentParseError(error: unknown): error is DocumentParseError {
  if (error instanceof DocumentParseError) return true;
  if (!error || typeof error !== "object") return false;

  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    DOCUMENT_PARSE_ERROR_CODES.includes(candidate.code as DocumentParseErrorCode)
  );
}

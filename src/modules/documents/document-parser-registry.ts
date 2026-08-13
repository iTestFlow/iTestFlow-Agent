import "server-only";

import {
  type DocumentFormat,
  DocumentParseError,
  type DocumentParseInput,
  type DocumentParser,
  isDocumentFormat,
  type ParsedDocument,
} from "./parsed-document.types";
import { csvDocumentParser, xlsxDocumentParser } from "./parsers/spreadsheet-document.parser";
import { docxDocumentParser } from "./parsers/docx-document.parser";
import { markdownDocumentParser } from "./parsers/markdown-document.parser";
import { pdfDocumentParser } from "./parsers/pdf-document.parser";
import { textDocumentParser } from "./parsers/text-document.parser";
import { jpegDocumentParser, pngDocumentParser, webpDocumentParser } from "./parsers/image-document.parser";

/**
 * Bump only when a parser's emitted structure changes materially. Versions are
 * persisted by the ingest service so an explicit reprocess is required for any
 * semantic parser upgrade.
 *
 * 1.1.0: DOCX now emits heading-structured sections (mammoth convertToHtml)
 * instead of flat paragraph text, so existing DOCX parses must be reprocessed.
 * 1.2.0: PNG, JPEG, and WebP now emit confidence-filtered local OCR regions.
 */
export const DOCUMENT_PARSE_RECIPE_VERSION = "1.2.0";

const PARSERS: Partial<Record<DocumentFormat, DocumentParser>> = {
  pdf: pdfDocumentParser,
  docx: docxDocumentParser,
  xlsx: xlsxDocumentParser,
  csv: csvDocumentParser,
  txt: textDocumentParser,
  md: markdownDocumentParser,
  png: pngDocumentParser,
  jpeg: jpegDocumentParser,
  webp: webpDocumentParser,
};

export function createDocumentParser(format: DocumentFormat | string): DocumentParser {
  if (!isDocumentFormat(format)) {
    throw new DocumentParseError({
      code: "unsupported_format",
      message: `No document parser is registered for “${String(format)}”.`,
    });
  }
  const parser = PARSERS[format];
  if (!parser) {
    throw new DocumentParseError({
      code: "unsupported_format",
      message: `No document parser is registered for “${String(format)}”.`,
    });
  }
  return parser;
}

export async function parseDocument(input: DocumentParseInput & { format: DocumentFormat | string }): Promise<ParsedDocument> {
  return createDocumentParser(input.format).parse(input);
}

export function supportedDocumentFormats() {
  return Object.keys(PARSERS) as DocumentFormat[];
}

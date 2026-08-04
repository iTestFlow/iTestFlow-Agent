import {
  getDocument,
  PasswordException,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { DocumentParseError, type DocumentParser, type ParsedDocumentSection, type ParsedDocumentWarning } from "../parsed-document.types";
import {
  assertNotAborted,
  createNoTextWarning,
  createParsedDocument,
  normalizeExtractedText,
  resolveExtractedTextLimit,
} from "./parser-utils";

export const MAX_PDF_PAGES = 300;

export const pdfDocumentParser: DocumentParser = {
  format: "pdf",

  async parse(input) {
    assertNotAborted(input.signal);
    let loadingTask: PDFDocumentLoadingTask | undefined;
    try {
      // Copy the buffer because PDF.js may transfer/detach its input ArrayBuffer.
      loadingTask = getDocument({
        data: new Uint8Array(input.data),
        stopAtErrors: false,
      });
      const pdf = await loadingTask.promise;
      assertNotAborted(input.signal);

      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new DocumentParseError({
          code: "oversized",
          message: `PDF files are limited to ${MAX_PDF_PAGES} pages.`,
        });
      }

      const sections: ParsedDocumentSection[] = [];
      const warnings: ParsedDocumentWarning[] = [];
      let parsedPageCount = 0;
      let extractedTextChars = 0;
      const textLimit = resolveExtractedTextLimit(input.maxExtractedTextChars);

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        assertNotAborted(input.signal);
        try {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          assertNotAborted(input.signal);
          parsedPageCount += 1;

          const text = normalizeExtractedText(textContentToString(content.items));
          if (!text) {
            warnings.push({
              code: "no_extractable_text",
              message: `Page ${pageNumber} has no extractable text layer.`,
              sectionKey: `page-${pageNumber}`,
              pageNumber,
            });
            continue;
          }
          extractedTextChars += text.length;
          if (extractedTextChars > textLimit) {
            throw new DocumentParseError({
              code: "oversized",
              message: `Extracted text exceeds the ${textLimit.toLocaleString()} character safety limit.`,
            });
          }

          sections.push({
            sectionKey: `page-${pageNumber}`,
            kind: "page",
            text,
            pageNumber,
            metadata: { origin: "document_text", pageNumber },
          });
        } catch (error) {
          if (error instanceof DocumentParseError) throw error;
          warnings.push({
            code: "page_parse_failed",
            message: `Page ${pageNumber} could not be parsed.`,
            sectionKey: `page-${pageNumber}`,
            pageNumber,
          });
        }
      }

      if (sections.length === 0 && !warnings.some((warning) => warning.code === "no_extractable_text")) {
        warnings.push(createNoTextWarning());
      }
      const status = sections.length > 0 && warnings.length > 0 ? "partially_parsed" : undefined;
      return createParsedDocument({
        format: "pdf",
        sections,
        warnings,
        status,
        metadata: {
          pageCount: pdf.numPages,
          parsedPageCount,
        },
      });
    } catch (error) {
      if (error instanceof DocumentParseError) throw error;
      throw pdfParseError(error);
    } finally {
      if (loadingTask) await loadingTask.destroy();
    }
  },
};

type PdfTextItem = {
  str: string;
  hasEOL: boolean;
};

function textContentToString(items: unknown[]) {
  let output = "";
  for (const item of items) {
    if (!isTextItem(item)) continue;
    output += item.str;
    if (item.hasEOL) output += "\n";
  }
  return output;
}

function isTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== "object" || !("str" in value)) return false;
  const candidate = value as { str?: unknown; hasEOL?: unknown };
  return typeof candidate.str === "string" && typeof candidate.hasEOL === "boolean";
}

function pdfParseError(error: unknown) {
  if (error instanceof PasswordException || (error instanceof Error && /password|encrypt/i.test(error.message))) {
    return new DocumentParseError({
      code: "password_protected",
      message: "Password-protected PDF files are not supported.",
      cause: error,
    });
  }
  return new DocumentParseError({
    code: "corrupted",
    message: "The PDF file could not be parsed.",
    cause: error,
  });
}

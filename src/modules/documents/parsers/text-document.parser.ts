import type { DocumentParser } from "../parsed-document.types";
import {
  assertNotAborted,
  assertWithinExtractedTextLimit,
  createNoTextWarning,
  createParsedDocument,
  decodeTextBytes,
  normalizeExtractedText,
  paragraphSections,
} from "./parser-utils";

export const textDocumentParser: DocumentParser = {
  format: "txt",

  async parse(input) {
    assertNotAborted(input.signal);
    const text = normalizeExtractedText(decodeTextBytes(input.data));
    assertWithinExtractedTextLimit(text, input.maxExtractedTextChars);
    assertNotAborted(input.signal);

    const sections = paragraphSections({ text, metadata: { origin: "document_text" } });
    return createParsedDocument({
      format: "txt",
      sections,
      warnings: sections.length === 0 ? [createNoTextWarning()] : [],
    });
  },
};

import { expectTypeOf, it } from "vitest";

import type { OcrDocumentMetadata, ParsedDocumentMetadata } from "./parsed-document.types";

it("types OCR metadata without closing parser-specific metadata extension", () => {
  expectTypeOf<NonNullable<ParsedDocumentMetadata["ocr"]>>().toEqualTypeOf<OcrDocumentMetadata>();
  expectTypeOf<ParsedDocumentMetadata["futureParserField"]>().toEqualTypeOf<unknown>();
  expectTypeOf<OcrDocumentMetadata["engine"]>().toEqualTypeOf<"tesseract.js">();
  expectTypeOf<OcrDocumentMetadata["status"]>().toEqualTypeOf<"parsed" | "partially_parsed" | "no_text" | "low_confidence">();
});

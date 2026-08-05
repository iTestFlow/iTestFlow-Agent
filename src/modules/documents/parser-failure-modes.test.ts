import { describe, expect, it } from "vitest";

import {
  corruptedDocx,
  encryptedPdf,
  rtlCsv,
  rtlTxt,
} from "../../test/fixtures/documents/builders";
import { createDocumentParser } from "./document-parser-registry";
import { DocumentParseError, isDocumentParseError } from "./parsed-document.types";

/**
 * Exercises each parser directly (bypassing document-upload-validation, which
 * has its own dedicated test suite) so the DocumentParseError taxonomy each
 * parser actually emits — not just the validator's pre-checks — is pinned.
 */
describe("document parser failure modes", () => {
  it("classifies a corrupted DOCX archive as `corrupted`", async () => {
    await expect(createDocumentParser("docx").parse({ data: corruptedDocx() }))
      .rejects.toMatchObject({ code: "corrupted" } satisfies Partial<DocumentParseError>);
  });

  it("classifies an encrypted PDF as `password_protected`", async () => {
    await expect(createDocumentParser("pdf").parse({ data: encryptedPdf() }))
      .rejects.toMatchObject({ code: "password_protected" } satisfies Partial<DocumentParseError>);
  });

  it("parses a plain TXT file into paragraph sections (happy path)", async () => {
    const result = await createDocumentParser("txt").parse({
      data: new TextEncoder().encode("First paragraph.\n\nSecond paragraph, with more detail."),
    });

    expect(result.status).toBe("parsed");
    expect(result.warnings).toEqual([]);
    // Short paragraphs are grouped into one section (see paragraphSections'
    // maxSectionChars); they only split once the joined text passes 8,000 chars.
    expect(result.sections).toEqual([
      expect.objectContaining({
        kind: "paragraph",
        sectionKey: "paragraph-1",
        text: "First paragraph.\n\nSecond paragraph, with more detail.",
      }),
    ]);
  });

  it("preserves Arabic (RTL) content verbatim when parsing a CSV", async () => {
    const result = await createDocumentParser("csv").parse({ data: rtlCsv() });

    expect(result.status).toBe("parsed");
    const text = result.sections.map((section) => section.text).join("\n");
    expect(text).toContain("تحقق من صحة الطلب");
    expect(text).toContain("Verify the order");
  });

  it("preserves Arabic (RTL) content verbatim when parsing a TXT file", async () => {
    const result = await createDocumentParser("txt").parse({ data: rtlTxt() });

    expect(result.status).toBe("parsed");
    expect(result.sections).toEqual([
      expect.objectContaining({
        kind: "paragraph",
        text: "مرحبا بالعالم، هذا اختبار\n\nHello world, this is a test",
      }),
    ]);
  });

  describe("empty buffer per format", () => {
    it("TXT: reports an empty status with a no-extractable-text warning instead of throwing", async () => {
      const result = await createDocumentParser("txt").parse({ data: new Uint8Array(0) });
      expect(result.status).toBe("empty");
      expect(result.sections).toEqual([]);
      expect(result.warnings).toEqual([expect.objectContaining({ code: "no_extractable_text" })]);
    });

    it("Markdown: reports an empty status with a no-extractable-text warning instead of throwing", async () => {
      const result = await createDocumentParser("md").parse({ data: new Uint8Array(0) });
      expect(result.status).toBe("empty");
      expect(result.sections).toEqual([]);
      expect(result.warnings).toEqual([expect.objectContaining({ code: "no_extractable_text" })]);
    });

    it("PDF: an empty buffer is not a parseable PDF at all, so it is thrown as `corrupted`", async () => {
      try {
        await createDocumentParser("pdf").parse({ data: new Uint8Array(0) });
        expect.unreachable("expected the empty-buffer PDF parse to throw");
      } catch (error) {
        expect(isDocumentParseError(error)).toBe(true);
        expect((error as DocumentParseError).code).toBe("corrupted");
      }
    });

    it("DOCX: an empty buffer is not a valid ZIP/OOXML package, so it is thrown as `corrupted`", async () => {
      try {
        await createDocumentParser("docx").parse({ data: new Uint8Array(0) });
        expect.unreachable("expected the empty-buffer DOCX parse to throw");
      } catch (error) {
        expect(isDocumentParseError(error)).toBe(true);
        expect((error as DocumentParseError).code).toBe("corrupted");
      }
    });

    it("CSV: reports an empty status with a no-extractable-text warning instead of throwing", async () => {
      const result = await createDocumentParser("csv").parse({ data: new Uint8Array(0) });
      expect(result.status).toBe("empty");
      expect(result.sections).toEqual([]);
      expect(result.warnings).toEqual([expect.objectContaining({ code: "no_extractable_text" })]);
    });

    it("XLSX: reports an empty status with a no-extractable-text warning instead of throwing", async () => {
      const result = await createDocumentParser("xlsx").parse({ data: new Uint8Array(0) });
      expect(result.status).toBe("empty");
      expect(result.sections).toEqual([]);
      expect(result.warnings).toEqual([expect.objectContaining({ code: "no_extractable_text" })]);
    });
  });
});

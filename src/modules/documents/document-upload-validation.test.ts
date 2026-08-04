import JSZip from "jszip";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { oleCompoundEncryptedOffice, svgBuffer, zipBombXlsx } from "../../test/fixtures/documents/builders";
import { DocumentParseError } from "./parsed-document.types";
import {
  MAX_ZIP_ENTRY_COUNT,
  inspectZipArchive,
  validateDocumentUpload,
} from "./document-upload-validation";

describe("validateDocumentUpload", () => {
  it("accepts a real OOXML spreadsheet after inspecting its archive", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name"], ["Ada"]]), "Plan");
    const bytes = new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "array" }));

    const result = await validateDocumentUpload({
      fileName: "plan.xlsx",
      data: bytes,
      declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.format).toBe("xlsx");
    expect(result.zipArchive?.entries.some((entry) => entry.name === "xl/workbook.xml")).toBe(true);
  });

  it("rejects an extension/content mismatch", async () => {
    await expect(
      validateDocumentUpload({
        fileName: "notes.pdf",
        data: new TextEncoder().encode("plain text"),
        declaredMimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "unsupported_format" } satisfies Partial<DocumentParseError>);
  });

  it("rejects unsafe archive entry paths before a parser opens them", async () => {
    const zip = new JSZip();
    zip.file("../escape.txt", "nope");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    expect(() => inspectZipArchive(bytes)).toThrow(/traversal/i);
  });

  it("enforces the configured upload size before parsing any format", async () => {
    await expect(
      validateDocumentUpload({
        fileName: "notes.txt",
        data: new TextEncoder().encode("too large"),
        declaredMimeType: "text/plain",
        maxUploadBytes: 3,
      }),
    ).rejects.toMatchObject({ code: "oversized" } satisfies Partial<DocumentParseError>);
  });

  it("rejects macro-bearing Office packages before handing them to a parser", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("_rels/.rels", "<Relationships />");
    zip.file("xl/workbook.xml", "<workbook />");
    zip.file("xl/vbaProject.bin", new Uint8Array([0, 1, 2]));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      validateDocumentUpload({
        fileName: "macro.xlsx",
        data: bytes,
        declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).rejects.toMatchObject({ code: "unsupported_format" } satisfies Partial<DocumentParseError>);
  });

  it("rejects a ZIP bomb via the compression-ratio cap before any parser opens the archive", async () => {
    const bytes = await zipBombXlsx();

    await expect(
      validateDocumentUpload({
        fileName: "bomb.xlsx",
        data: bytes,
        declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).rejects.toMatchObject({ code: "oversized", message: expect.stringMatching(/compression ratio/i) } satisfies Partial<DocumentParseError>);
  });

  it("rejects an Office archive with more than MAX_ZIP_ENTRY_COUNT entries", async () => {
    const zip = new JSZip();
    for (let index = 0; index <= MAX_ZIP_ENTRY_COUNT; index += 1) zip.file(`f${index}.xml`, "x");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      validateDocumentUpload({
        fileName: "too-many-entries.xlsx",
        data: bytes,
        declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).rejects.toMatchObject({ code: "oversized", message: expect.stringMatching(/more than/i) } satisfies Partial<DocumentParseError>);
  });

  it("rejects SVG uploads purely by extension — SVG is not in the document-format allowlist", async () => {
    await expect(
      validateDocumentUpload({
        fileName: "image.svg",
        data: svgBuffer(),
        declaredMimeType: "image/svg+xml",
      }),
    ).rejects.toMatchObject({ code: "unsupported_format" } satisfies Partial<DocumentParseError>);
  });

  it("rejects an OLE-compound (password-protected) Office document before any ZIP bytes are read", async () => {
    await expect(
      validateDocumentUpload({
        fileName: "protected.docx",
        data: oleCompoundEncryptedOffice(),
        declaredMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toMatchObject({ code: "password_protected" } satisfies Partial<DocumentParseError>);
  });
});

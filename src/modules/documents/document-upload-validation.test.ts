import JSZip from "jszip";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { oleCompoundEncryptedOffice, svgBuffer, zipBombXlsx } from "../../test/fixtures/documents/builders";
import { DocumentParseError } from "./parsed-document.types";
import {
  canonicalDocumentMimeType,
  MAX_ZIP_ENTRY_COUNT,
  inspectZipArchive,
  validateDocumentUpload,
} from "./document-upload-validation";

describe("validateDocumentUpload", () => {
  it("accepts a valid PNG after verifying its bytes and dimensions", async () => {
    const bytes = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const result = await validateDocumentUpload({
      fileName: "screenshot.png",
      data: bytes,
      declaredMimeType: "image/png",
    });

    expect(result).toMatchObject({
      format: "png",
      extension: "png",
      byteLength: bytes.byteLength,
      detectedMimeType: "image/png",
      image: { width: 1, height: 1 },
    });
  });

  it("normalizes a valid .jpg upload to the JPEG document format", async () => {
    const bytes = imageFixture(
      "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
    );

    const result = await validateDocumentUpload({
      fileName: "photo.jpg",
      data: bytes,
      declaredMimeType: "image/jpeg",
    });

    expect(result).toMatchObject({
      format: "jpeg",
      extension: "jpg",
      detectedMimeType: "image/jpeg",
      image: { width: 1, height: 1 },
    });
  });

  it("accepts a valid WebP after verifying its bytes and dimensions", async () => {
    const bytes = imageFixture("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=");

    const result = await validateDocumentUpload({
      fileName: "capture.webp",
      data: bytes,
      declaredMimeType: "image/webp",
    });

    expect(result).toMatchObject({
      format: "webp",
      extension: "webp",
      detectedMimeType: "image/webp",
      image: { width: 1, height: 1 },
    });
  });

  it("rejects an image whose detected signature does not match its extension", async () => {
    const pngBytes = imageFixture(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );

    await expect(
      validateDocumentUpload({
        fileName: "spoofed.jpg",
        data: pngBytes,
        declaredMimeType: "image/jpeg",
      }),
    ).rejects.toMatchObject({
      code: "unsupported_format",
      message: expect.stringMatching(/detected content type/i),
    } satisfies Partial<DocumentParseError>);
  });

  it("rejects an image whose declared MIME type does not match its extension", async () => {
    const pngBytes = imageFixture(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );

    await expect(
      validateDocumentUpload({
        fileName: "spoofed.png",
        data: pngBytes,
        declaredMimeType: "image/jpeg",
      }),
    ).rejects.toMatchObject({
      code: "unsupported_format",
      message: expect.stringMatching(/declared MIME type/i),
    } satisfies Partial<DocumentParseError>);
  });

  it("rejects corrupt image bytes even when their extension and declared MIME agree", async () => {
    const truncatedWebp = new TextEncoder().encode("RIFF\0\0\0\0WEBP");

    await expect(
      validateDocumentUpload({
        fileName: "broken.webp",
        data: truncatedWebp,
        declaredMimeType: "image/webp",
      }),
    ).rejects.toMatchObject({
      code: "corrupted",
      message: expect.stringMatching(/dimensions|corrupt/i),
    } satisfies Partial<DocumentParseError>);
  });

  it("rejects a truncated PNG that still contains a valid signature and IHDR dimensions", async () => {
    const headerOnlyPng = imageFixture(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC",
    );
    expect(headerOnlyPng).toHaveLength(33);

    await expect(
      validateDocumentUpload({
        fileName: "header-only.png",
        data: headerOnlyPng,
        declaredMimeType: "image/png",
      }),
    ).rejects.toMatchObject({
      code: "corrupted",
      message: expect.stringMatching(/corrupt|decode/i),
    } satisfies Partial<DocumentParseError>);
  });

  it("rejects an image whose dimensions exceed the configured pixel cap", async () => {
    const twoPixelPng = imageFixture(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII=",
    );

    await expect(
      validateDocumentUpload({
        fileName: "wide.png",
        data: twoPixelPng,
        declaredMimeType: "image/png",
        maxImagePixels: 1,
      }),
    ).rejects.toMatchObject({
      code: "oversized",
      message: expect.stringMatching(/pixel/i),
    } satisfies Partial<DocumentParseError>);
  });

  it("provides one canonical MIME mapping for both upload routes", () => {
    expect([
      canonicalDocumentMimeType("png"),
      canonicalDocumentMimeType("jpeg"),
      canonicalDocumentMimeType("webp"),
    ]).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

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

  it("rejects a ZIP entry via the per-entry uncompressed-size cap before any parser opens the archive", async () => {
    const zip = new JSZip();
    zip.file("xl/worksheets/sheet1.xml", new Uint8Array(1_024), { compression: "STORE" });
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      validateDocumentUpload({
        fileName: "big-entry.xlsx",
        data: bytes,
        declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        zipSizeLimits: { maxEntryUncompressedBytes: 512 },
      }),
    ).rejects.toMatchObject({
      code: "oversized",
      message: expect.stringMatching(/entry exceeds the uncompressed-size/i),
    } satisfies Partial<DocumentParseError>);
  });

  it("rejects a ZIP whose entries sum past the total uncompressed-size cap before any parser opens the archive", async () => {
    const zip = new JSZip();
    zip.file("xl/worksheets/sheet1.xml", new Uint8Array(1_000), { compression: "STORE" });
    zip.file("xl/worksheets/sheet2.xml", new Uint8Array(1_000), { compression: "STORE" });
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      validateDocumentUpload({
        fileName: "big-total.xlsx",
        data: bytes,
        declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        zipSizeLimits: { maxTotalUncompressedBytes: 1_500 },
      }),
    ).rejects.toMatchObject({
      code: "oversized",
      message: expect.stringMatching(/total uncompressed-size/i),
    } satisfies Partial<DocumentParseError>);
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

function imageFixture(base64: string) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

import JSZip from "jszip";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";

import { createDocumentParser, parseDocument } from "./document-parser-registry";

/** Builds a minimal single-part OOXML package around the given document.xml body. */
async function buildDocx(documentXml: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentXml}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

describe("document parser registry", () => {
  it.each(["png", "jpeg", "webp"] as const)("fails closed for %s until an OCR parser is registered", (format) => {
    expect(() => createDocumentParser(format)).toThrow(
      expect.objectContaining({ code: "unsupported_format", message: expect.stringMatching(/no document parser/i) }),
    );
  });

  it("preserves heading and RTL text in Markdown sections", async () => {
    const result = await parseDocument({
      format: "md",
      data: new TextEncoder().encode("# خطة الإصدار\n\nShip the release safely."),
    });

    expect(result.status).toBe("parsed");
    expect(result.sections).toEqual([
      expect.objectContaining({
        kind: "heading",
        sectionKey: "heading-خطة-الإصدار",
        text: "# خطة الإصدار\n\nShip the release safely.",
      }),
    ]);
  });

  it("turns a quoted CSV into coordinate-bearing sheet ranges", async () => {
    const result = await parseDocument({
      format: "csv",
      data: new TextEncoder().encode('Name,Description\nAda,"Works, remotely"'),
    });

    expect(result.sections).toEqual([
      expect.objectContaining({
        kind: "sheet_range",
        sectionKey: "sheet-Sheet1!A1:D40",
        text: "A1\tName\tDescription\nA2\tAda\tWorks, remotely",
      }),
    ]);
  });

  it("parses XLSX cells without evaluating formulas", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["Total"], [2]]);
    sheet.A3 = { t: "n", f: "SUM(A2:A2)", v: 2, w: "2" };
    sheet["!ref"] = "A1:A3";
    XLSX.utils.book_append_sheet(workbook, sheet, "Budget");

    const bytes = new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "array" }));
    const result = await parseDocument({ format: "xlsx", data: bytes });

    expect(result.sections[0]).toEqual(
      expect.objectContaining({
        sectionKey: "sheet-Budget!A1:D40",
        text: "A1\tTotal\nA2\t2\nA3\t2",
      }),
    );
  });

  it("parses DOCX raw text into plain paragraph sections when there is no heading", async () => {
    const bytes = await buildDocx('<w:p><w:r><w:t>Hello مرحبا</w:t></w:r></w:p>');

    const result = await parseDocument({ format: "docx", data: bytes });

    expect(result.status).toBe("parsed");
    expect(result.sections[0]).toEqual(expect.objectContaining({ kind: "paragraph", text: "Hello مرحبا" }));
  });

  it("groups DOCX paragraphs under heading-derived sections", async () => {
    const bytes = await buildDocx(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release Notes</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Ship the release safely.</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>تفاصيل مهمة عن الإصدار.</w:t></w:r></w:p>',
    );

    const result = await parseDocument({ format: "docx", data: bytes });

    expect(result.status).toBe("parsed");
    expect(result.sections).toEqual([
      expect.objectContaining({
        kind: "heading",
        sectionKey: "heading-release-notes",
        text: "Release Notes\n\nShip the release safely.",
      }),
      expect.objectContaining({
        kind: "heading",
        sectionKey: "heading-details",
        text: "Details\n\nتفاصيل مهمة عن الإصدار.",
      }),
    ]);
    for (const section of result.sections) {
      expect(section.text).not.toContain("<");
    }
  });

  it("falls back to flat paragraph text with a warning when heading-structured conversion fails", async () => {
    const bytes = await buildDocx('<w:p><w:r><w:t>Hello مرحبا</w:t></w:r></w:p>');

    const spy = vi.spyOn(mammoth, "convertToHtml").mockRejectedValueOnce(new Error("simulated HTML conversion failure"));
    try {
      const result = await parseDocument({ format: "docx", data: bytes });

      expect(result.status).toBe("parsed");
      expect(result.sections[0]).toEqual(expect.objectContaining({ kind: "paragraph", text: "Hello مرحبا" }));
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "parser_message", message: expect.stringContaining("falling back") })]),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("parses DOCX table rows, including a row with empty cells", async () => {
    const bytes = await buildDocx(
      "<w:tbl>" +
        "<w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc></w:tr>" +
        "<w:tr><w:tc><w:p><w:r><w:t>Ada</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Engineer</w:t></w:r></w:p></w:tc></w:tr>" +
        "<w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>" +
        "</w:tbl>",
    );

    const result = await parseDocument({ format: "docx", data: bytes });

    expect(result.status).toBe("parsed");
    const text = result.sections.map((section) => section.text).join("\n");
    expect(text).toContain("Name");
    expect(text).toContain("Engineer");
  });

  it("reports no extractable text for a DOCX with no paragraphs", async () => {
    const bytes = await buildDocx("");

    const result = await parseDocument({ format: "docx", data: bytes });

    expect(result.status).toBe("empty");
    expect(result.sections).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "no_extractable_text" })]),
    );
  });

  it("extracts text-layer PDF pages with page locators", async () => {
    const result = await parseDocument({ format: "pdf", data: createTextPdf("Hello PDF") });

    expect(result.status).toBe("parsed");
    expect(result.sections).toEqual([
      expect.objectContaining({ kind: "page", sectionKey: "page-1", pageNumber: 1, text: "Hello PDF" }),
    ]);
  });

  it("reports a text-layer warning for scanned/empty PDF pages instead of inventing content", async () => {
    const result = await parseDocument({ format: "pdf", data: createTextPdf("") });

    expect(result.status).toBe("empty");
    expect(result.sections).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "no_extractable_text", sectionKey: "page-1", pageNumber: 1 }),
    ]);
  });
});

function createTextPdf(text: string) {
  const chunks = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  const byteLength = () => chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, "ascii"), 0);
  const addObject = (id: number, body: string) => {
    offsets[id] = byteLength();
    chunks.push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  const content = `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, "\\$&")}) Tj\nET`;
  addObject(4, `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`);
  addObject(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const xrefOffset = byteLength();
  chunks.push("xref\n0 6\n0000000000 65535 f \n");
  for (let id = 1; id <= 5; id += 1) chunks.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new TextEncoder().encode(chunks.join(""));
}

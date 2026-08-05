/**
 * Small, pure fixture builders for document-upload/parser tests. Every builder
 * returns freshly constructed bytes at call time — nothing here is a checked-in
 * binary file — so the threat/edge case each one encodes stays legible in the
 * test that uses it.
 */

import JSZip from "jszip";

const OLE_COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function buildPdf(objects: Array<{ id: number; body: string }>, trailerExtra = ""): Uint8Array {
  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  const byteLength = () => chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, "ascii"), 0);
  let maxId = 0;
  for (const { id, body } of objects) {
    offsets[id] = byteLength();
    chunks.push(`${id} 0 obj\n${body}\nendobj\n`);
    maxId = Math.max(maxId, id);
  }

  const xrefOffset = byteLength();
  chunks.push(`xref\n0 ${maxId + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= maxId; id += 1) chunks.push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new TextEncoder().encode(chunks.join(""));
}

function textPageObjects(content: string) {
  return [
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { id: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>" },
    { id: 4, body: `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream` },
    { id: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ];
}

/** Happy-path / empty-text-layer fixture: a hand-built single-page PDF with one text-showing operator. */
export function minimalTextPdf(text: string): Uint8Array {
  const content = `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, "\\$&")}) Tj\nET`;
  return buildPdf(textPageObjects(content));
}

/**
 * Password-protected-PDF fixture: a normal-looking page plus a trailer /Encrypt
 * reference whose /O and /U values are all-zero (never the real digest of the
 * empty default password). pdf.js rejects the empty password on load and
 * rejects with a password/encryption error before any page is read, which the
 * parser classifies as `password_protected`.
 */
export function encryptedPdf(): Uint8Array {
  const zero32Hex = "00".repeat(32);
  const zero16Hex = "00".repeat(16);
  const objects = [
    ...textPageObjects("BT\n/F1 18 Tf\n72 720 Td\n(Secret) Tj\nET"),
    { id: 6, body: `<< /Filter /Standard /V 1 /R 2 /O <${zero32Hex}> /U <${zero32Hex}> /P -3904 >>` },
  ];
  return buildPdf(objects, ` /Encrypt 6 0 R /ID [<${zero16Hex}> <${zero16Hex}>]`);
}

/**
 * OLE compound-file signature (the container real password-protected legacy
 * .doc/.xls and MS-OFFCRYPTO-encrypted OOXML files use): trips the upload
 * validator's password_protected short-circuit before any ZIP bytes are read.
 */
export function oleCompoundEncryptedOffice(): Uint8Array {
  return new Uint8Array([...OLE_COMPOUND_FILE_SIGNATURE, ...new Array(24).fill(0)]);
}

/** Corrupted-archive fixture: a real ZIP local-file-header signature followed by non-ZIP bytes, so no End-Of-Central-Directory record ever appears. */
export function corruptedDocx(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not a real zip archive, just garbage trailing a PK local-file-header signature", "ascii")]);
}

async function buildDocxPackage(documentXml: string): Promise<Uint8Array> {
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

/** RTL content-preservation fixture: a minimal DOCX with one Arabic paragraph and one English paragraph. */
export function arabicDocx(): Promise<Uint8Array> {
  return buildDocxPackage(
    "<w:p><w:r><w:t>مرحبا بالعالم، هذا اختبار</w:t></w:r></w:p><w:p><w:r><w:t>Hello world, this is a test</w:t></w:r></w:p>",
  );
}

/**
 * Zip-bomb fixture: a real OOXML-shaped ZIP whose lone sheet entry is 2,000,000
 * zero bytes. DEFLATE compresses that run to only a few hundred bytes, so the
 * real (not fabricated) declared-vs-compressed ratio trips
 * MAX_ZIP_COMPRESSION_RATIO — the cheapest of document-upload-validation's ZIP
 * caps to violate without writing a genuinely huge archive to memory.
 */
export async function zipBombXlsx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("xl/worksheets/sheet1.xml", new Uint8Array(2_000_000), {
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  return zip.generateAsync({ type: "uint8array" });
}

/** SVG markup (can carry <script>): used to prove SVG is rejected purely by extension allowlist, not sniffed from content. */
export function svgBuffer(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
}

/**
 * RTL content-preservation fixture: a quoted CSV with an Arabic data row
 * alongside an English one. Leads with a UTF-8 BOM because the xlsx library's
 * CSV auto-detection otherwise assumes a Latin-1-family codepage and mangles
 * non-ASCII bytes into mojibake — the BOM is what a real Excel-exported UTF-8
 * CSV carries too.
 */
export function rtlCsv(): Uint8Array {
  const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const csv = new TextEncoder().encode('Name,Description\nAda,"تحقق من صحة الطلب"\nLin,"Verify the order"');
  return new Uint8Array([...utf8Bom, ...csv]);
}

/** RTL content-preservation fixture: plain text alternating an Arabic paragraph and an English paragraph. */
export function rtlTxt(): Uint8Array {
  return new TextEncoder().encode("مرحبا بالعالم، هذا اختبار\n\nHello world, this is a test");
}

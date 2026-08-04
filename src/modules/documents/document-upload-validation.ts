import "server-only";

import { fileTypeFromBuffer } from "file-type";

import {
  type DocumentFormat,
  DocumentParseError,
  isDocumentFormat,
} from "./parsed-document.types";
import { isDecodableText } from "./parsers/parser-utils";

export const DEFAULT_DOCUMENT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ABSOLUTE_DOCUMENT_MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

/** ZIP limits apply before OOXML reaches Mammoth or SheetJS. */
export const MAX_ZIP_ENTRY_COUNT = 4_096;
export const MAX_ZIP_ENTRY_NAME_BYTES = 1_024;
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_COMPRESSION_RATIO = 100;

const OLE_COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffffffff;

const MIME_TYPES_BY_FORMAT: Record<DocumentFormat, readonly string[]> = {
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv", "application/csv", "application/vnd.ms-excel"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/x-markdown", "text/plain"],
};

const GENERIC_TEXT_MIME_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "text/x-markdown"]);
const GENERIC_BINARY_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export type ZipArchiveEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
};

export type ZipArchiveInspection = {
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  entries: ZipArchiveEntry[];
};

export type DocumentUploadValidationInput = {
  fileName: string;
  data: Uint8Array;
  /** Browser-provided MIME metadata; never trusted in place of byte checks. */
  declaredMimeType?: string | null;
  /** Useful for a Content-Length pre-check and streamed-byte counter. */
  maxUploadBytes?: number;
};

export type ValidatedDocumentUpload = {
  format: DocumentFormat;
  extension: string;
  byteLength: number;
  detectedMimeType?: string;
  zipArchive?: ZipArchiveInspection;
};

/**
 * Resolves the deployment-level cap. Values are bytes; invalid values safely
 * fall back to the documented 50 MiB default instead of disabling validation.
 */
export function getDocumentMaxUploadBytes(environment = process.env) {
  const raw = environment.DOCUMENT_MAX_UPLOAD_BYTES;
  if (!raw) return DEFAULT_DOCUMENT_MAX_UPLOAD_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_DOCUMENT_MAX_UPLOAD_BYTES;
  return Math.min(parsed, ABSOLUTE_DOCUMENT_MAX_UPLOAD_BYTES);
}

export function assertDocumentUploadSize(byteLength: number, maxUploadBytes = getDocumentMaxUploadBytes()) {
  const limit = normalizeUploadLimit(maxUploadBytes);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new DocumentParseError({ code: "corrupted", message: "The upload size is invalid." });
  }
  if (byteLength > limit) {
    throw new DocumentParseError({
      code: "oversized",
      message: `The upload exceeds the ${formatBytes(limit)} size limit.`,
    });
  }
}

/**
 * Enforces the extension-plus-content allowlist at the upload boundary. Text
 * formats are verified as strictly decodable text; OOXML files are additionally
 * inspected as bounded, non-encrypted ZIP containers before any parser opens
 * them. This is intentionally not a MIME-only check.
 */
export async function validateDocumentUpload(input: DocumentUploadValidationInput): Promise<ValidatedDocumentUpload> {
  const format = documentFormatFromFileName(input.fileName);
  assertDocumentUploadSize(input.data.byteLength, input.maxUploadBytes);

  const declaredMimeType = normalizeMimeType(input.declaredMimeType);
  assertDeclaredMimeTypeCompatible(format, declaredMimeType);

  if (isOleCompoundFile(input.data) && (format === "docx" || format === "xlsx")) {
    throw new DocumentParseError({
      code: "password_protected",
      message: "Password-protected Office documents are not supported.",
    });
  }

  const detected = await detectFileType(input.data);
  assertDetectedTypeCompatible(format, detected?.mime, detected?.ext);

  let zipArchive: ZipArchiveInspection | undefined;
  switch (format) {
    case "pdf":
      if (!hasPdfMagicBytes(input.data)) {
        throw new DocumentParseError({
          code: "unsupported_format",
          message: "The file extension says PDF, but its bytes are not a PDF.",
        });
      }
      break;
    case "docx":
    case "xlsx":
      zipArchive = inspectZipArchive(input.data);
      assertOfficePackageMatchesFormat(format, zipArchive);
      break;
    case "csv":
    case "txt":
    case "md":
      if (!isTextLike(input.data)) {
        throw new DocumentParseError({
          code: "unsupported_format",
          message: "The file extension says text, but its bytes are binary or use an unsupported encoding.",
        });
      }
      break;
  }

  return {
    format,
    extension: extensionFromFileName(input.fileName),
    byteLength: input.data.byteLength,
    detectedMimeType: detected?.mime,
    zipArchive,
  };
}

export function documentFormatFromFileName(fileName: string): DocumentFormat {
  const extension = extensionFromFileName(fileName);
  if (!isDocumentFormat(extension)) {
    throw new DocumentParseError({
      code: "unsupported_format",
      message: "Only PDF, DOCX, XLSX, CSV, TXT, and Markdown documents are supported.",
    });
  }
  return extension;
}

/**
 * Reads ZIP central-directory metadata without extracting an entry. Mammoth and
 * SheetJS receive data only after this guard rejects encryption, traversal,
 * excessive entry counts, expansion size, and suspicious compression ratios.
 */
export function inspectZipArchive(data: Uint8Array): ZipArchiveInspection {
  const end = findEndOfCentralDirectory(data);
  const diskNumber = readUint16LE(data, end + 4);
  const centralDirectoryDisk = readUint16LE(data, end + 6);
  const entryCountOnDisk = readUint16LE(data, end + 8);
  const entryCount = readUint16LE(data, end + 10);
  const centralDirectorySize = readUint32LE(data, end + 12);
  const centralDirectoryOffset = readUint32LE(data, end + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entryCountOnDisk !== entryCount) {
    throw zipCorrupted("Multi-volume ZIP archives are not supported.");
  }
  if (entryCount === ZIP64_UINT16 || centralDirectorySize === ZIP64_UINT32 || centralDirectoryOffset === ZIP64_UINT32) {
    throw zipCorrupted("ZIP64 archives are not supported.");
  }
  if (entryCount === 0) throw zipCorrupted("The Office archive contains no entries.");
  if (entryCount > MAX_ZIP_ENTRY_COUNT) {
    throw new DocumentParseError({
      code: "oversized",
      message: `The Office archive contains more than ${MAX_ZIP_ENTRY_COUNT.toLocaleString()} entries.`,
    });
  }
  assertRange(data, centralDirectoryOffset, centralDirectorySize, "central directory");

  const entries: ZipArchiveEntry[] = [];
  let cursor = centralDirectoryOffset;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32LE(data, cursor) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw zipCorrupted("The ZIP central directory is malformed.");
    }

    const flags = readUint16LE(data, cursor + 8);
    const compressionMethod = readUint16LE(data, cursor + 10);
    const compressedSize = readUint32LE(data, cursor + 20);
    const uncompressedSize = readUint32LE(data, cursor + 24);
    const fileNameLength = readUint16LE(data, cursor + 28);
    const extraLength = readUint16LE(data, cursor + 30);
    const commentLength = readUint16LE(data, cursor + 32);
    const diskStart = readUint16LE(data, cursor + 34);
    const localHeaderOffset = readUint32LE(data, cursor + 42);
    const recordSize = 46 + fileNameLength + extraLength + commentLength;

    assertRange(data, cursor, recordSize, "central-directory entry");
    if (fileNameLength > MAX_ZIP_ENTRY_NAME_BYTES) throw zipCorrupted("A ZIP entry name is too long.");
    if (diskStart !== 0) throw zipCorrupted("Multi-volume ZIP archives are not supported.");
    if (compressedSize === ZIP64_UINT32 || uncompressedSize === ZIP64_UINT32 || localHeaderOffset === ZIP64_UINT32) {
      throw zipCorrupted("ZIP64 archives are not supported.");
    }
    if ((flags & 0x0001) !== 0) {
      throw new DocumentParseError({
        code: "password_protected",
        message: "Encrypted Office documents are not supported.",
      });
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw zipCorrupted("The Office archive uses an unsupported compression method.");
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      throw new DocumentParseError({
        code: "oversized",
        message: "An Office archive entry exceeds the uncompressed-size safety limit.",
      });
    }
    if (uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > MAX_ZIP_COMPRESSION_RATIO) {
      throw new DocumentParseError({
        code: "oversized",
        message: "The Office archive has a suspicious compression ratio.",
      });
    }

    const nameStart = cursor + 46;
    const name = decodeZipFileName(data.subarray(nameStart, nameStart + fileNameLength));
    assertSafeZipEntryName(name);
    assertLocalFileHeader(data, {
      offset: localHeaderOffset,
      compressionMethod,
      flags,
      compressedSize,
      centralDirectoryOffset,
    });

    totalCompressedBytes += compressedSize;
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new DocumentParseError({
        code: "oversized",
        message: "The Office archive exceeds the total uncompressed-size safety limit.",
      });
    }

    entries.push({ name, compressedSize, uncompressedSize, compressionMethod });
    cursor += recordSize;
  }

  if (cursor > centralDirectoryOffset + centralDirectorySize) {
    throw zipCorrupted("The ZIP central directory exceeds its declared bounds.");
  }

  return { entryCount, totalCompressedBytes, totalUncompressedBytes, entries };
}

function assertOfficePackageMatchesFormat(format: "docx" | "xlsx", zipArchive: ZipArchiveInspection) {
  const names = new Set(zipArchive.entries.map((entry) => entry.name.toLowerCase()));
  if (!names.has("[content_types].xml") || !names.has("_rels/.rels")) {
    throw zipCorrupted("The Office archive is missing required OOXML package entries.");
  }
  if (names.has("word/vbaproject.bin") || names.has("xl/vbaproject.bin")) {
    throw new DocumentParseError({
      code: "unsupported_format",
      message: "Macro-enabled Office documents are not supported.",
    });
  }

  const expectedEntry = format === "docx" ? "word/document.xml" : "xl/workbook.xml";
  const otherFormatEntry = format === "docx" ? "xl/workbook.xml" : "word/document.xml";
  if (!names.has(expectedEntry) || names.has(otherFormatEntry)) {
    throw new DocumentParseError({
      code: "unsupported_format",
      message: `The file extension does not match a valid ${format.toUpperCase()} package.`,
    });
  }
}

function assertDeclaredMimeTypeCompatible(format: DocumentFormat, declaredMimeType: string | undefined) {
  if (!declaredMimeType || GENERIC_BINARY_MIME_TYPES.has(declaredMimeType)) return;
  if (MIME_TYPES_BY_FORMAT[format].includes(declaredMimeType)) return;
  if (["csv", "txt", "md"].includes(format) && GENERIC_TEXT_MIME_TYPES.has(declaredMimeType)) return;
  throw new DocumentParseError({
    code: "unsupported_format",
    message: "The declared MIME type does not match the selected file extension.",
  });
}

function assertDetectedTypeCompatible(format: DocumentFormat, detectedMimeType?: string, detectedExtension?: string) {
  if (!detectedMimeType && !detectedExtension) return;
  if (format === "docx" || format === "xlsx") {
    // file-type can identify OOXML specifically or only its generic ZIP shell.
    if (detectedMimeType === "application/zip" || detectedExtension === "zip") return;
  }
  if (detectedMimeType && MIME_TYPES_BY_FORMAT[format].includes(detectedMimeType)) return;
  if (detectedExtension === format) return;
  throw new DocumentParseError({
    code: "unsupported_format",
    message: "The file extension does not match its detected content type.",
  });
}

async function detectFileType(data: Uint8Array) {
  try {
    return await fileTypeFromBuffer(data);
  } catch {
    // Our explicit magic-byte and ZIP checks below remain authoritative. Some
    // very small valid inputs simply do not give file-type enough bytes.
    return undefined;
  }
}

function extensionFromFileName(fileName: string) {
  const baseName = fileName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = /\.([a-z0-9]+)$/i.exec(baseName.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function hasPdfMagicBytes(data: Uint8Array) {
  return data.length >= 5 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d;
}

function isOleCompoundFile(data: Uint8Array) {
  return OLE_COMPOUND_FILE_SIGNATURE.every((byte, index) => data[index] === byte);
}

function isTextLike(data: Uint8Array) {
  if (data.byteLength === 0) return true;
  if (!isDecodableText(data)) return false;

  // A NUL byte is valid only as part of a BOM-marked UTF-16 stream. The ratio
  // check catches binary content that happens to be decodable as UTF-8.
  const utf16 = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff);
  if (utf16) return true;
  const sampleLength = Math.min(data.byteLength, 8 * 1024);
  let suspiciousControls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = data[index];
    if (byte === 0 || (byte < 0x09 && byte !== 0x00) || (byte > 0x0d && byte < 0x20)) suspiciousControls += 1;
  }
  return suspiciousControls / sampleLength <= 0.01;
}

function findEndOfCentralDirectory(data: Uint8Array) {
  const minimumOffset = Math.max(0, data.byteLength - 65_557);
  for (let offset = data.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32LE(data, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = readUint16LE(data, offset + 20);
    if (offset + 22 + commentLength === data.byteLength) return offset;
  }
  throw zipCorrupted("The Office archive has no valid ZIP central directory.");
}

function assertLocalFileHeader(
  data: Uint8Array,
  input: {
    offset: number;
    compressionMethod: number;
    flags: number;
    compressedSize: number;
    centralDirectoryOffset: number;
  },
) {
  assertRange(data, input.offset, 30, "local file header");
  if (readUint32LE(data, input.offset) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw zipCorrupted("A ZIP entry points outside the archive.");
  }
  const localFlags = readUint16LE(data, input.offset + 6);
  const localCompressionMethod = readUint16LE(data, input.offset + 8);
  const localFileNameLength = readUint16LE(data, input.offset + 26);
  const localExtraLength = readUint16LE(data, input.offset + 28);
  if (localFlags !== input.flags || localCompressionMethod !== input.compressionMethod) {
    throw zipCorrupted("A ZIP entry has inconsistent local-header metadata.");
  }
  const compressedDataOffset = input.offset + 30 + localFileNameLength + localExtraLength;
  assertRange(data, compressedDataOffset, input.compressedSize, "compressed entry data");
  if (compressedDataOffset + input.compressedSize > input.centralDirectoryOffset) {
    throw zipCorrupted("A ZIP entry overlaps the central directory.");
  }
}

function decodeZipFileName(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new DocumentParseError({ code: "corrupted", message: "A ZIP entry name is invalid.", cause });
  }
}

function assertSafeZipEntryName(name: string) {
  if (!name || name.startsWith("/") || name.startsWith("\\") || name.includes("\\") || name.includes("\u0000")) {
    throw zipCorrupted("The Office archive contains an unsafe entry name.");
  }
  if (name.split("/").some((part) => part === "..")) {
    throw zipCorrupted("The Office archive contains a traversal entry name.");
  }
}

function assertRange(data: Uint8Array, offset: number, length: number, label: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.byteLength) {
    throw zipCorrupted(`The ZIP ${label} is outside the archive bounds.`);
  }
}

function readUint16LE(data: Uint8Array, offset: number) {
  assertRange(data, offset, 2, "field");
  return data[offset] | (data[offset + 1] << 8);
}

function readUint32LE(data: Uint8Array, offset: number) {
  assertRange(data, offset, 4, "field");
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function normalizeMimeType(value: string | null | undefined) {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeUploadLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_DOCUMENT_MAX_UPLOAD_BYTES;
  return Math.min(value, ABSOLUTE_DOCUMENT_MAX_UPLOAD_BYTES);
}

function formatBytes(value: number) {
  return `${Math.round(value / (1024 * 1024))} MiB`;
}

function zipCorrupted(message: string) {
  return new DocumentParseError({ code: "corrupted", message });
}

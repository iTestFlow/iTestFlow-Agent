import * as XLSX from "xlsx";

import { DocumentParseError, type DocumentParseInput, type DocumentParser, type ParsedDocumentSection, type ParsedDocumentWarning } from "../parsed-document.types";
import {
  assertNotAborted,
  createNoTextWarning,
  createParsedDocument,
  resolveExtractedTextLimit,
} from "./parser-utils";

export const MAX_SPREADSHEET_SHEETS = 50;
export const MAX_SPREADSHEET_CELLS = 200_000;
export const MAX_SPREADSHEET_SECTIONS = 2_000;
export const SPREADSHEET_RANGE_ROWS = 40;
export const SPREADSHEET_RANGE_COLUMNS = 4;

type SpreadsheetCell = {
  address: string;
  row: number;
  column: number;
  cell: XLSX.CellObject;
};

type RangeGroup = {
  rowBlock: number;
  columnBlock: number;
  cells: SpreadsheetCell[];
};

export const xlsxDocumentParser: DocumentParser = {
  format: "xlsx",
  parse: (input) => parseSpreadsheetDocument("xlsx", input),
};

export const csvDocumentParser: DocumentParser = {
  format: "csv",
  parse: (input) => parseSpreadsheetDocument("csv", input),
};

export async function parseSpreadsheetDocument(format: "xlsx" | "csv", input: DocumentParseInput) {
  assertNotAborted(input.signal);

  try {
    const workbook = XLSX.read(input.data, {
      type: "array",
      raw: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellNF: false,
      cellText: true,
      sheetStubs: false,
      WTF: false,
    });
    assertNotAborted(input.signal);
    return workbookToParsedDocument(format, workbook, input);
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw spreadsheetParseError(error);
  }
}

function workbookToParsedDocument(format: "xlsx" | "csv", workbook: XLSX.WorkBook, input: DocumentParseInput) {
  const warnings: ParsedDocumentWarning[] = [];
  const sections: ParsedDocumentSection[] = [];
  const requestedSheetNames = workbook.SheetNames;
  const sheetNames = requestedSheetNames.slice(0, MAX_SPREADSHEET_SHEETS);
  const textLimit = resolveExtractedTextLimit(input.maxExtractedTextChars);
  let remainingCells = MAX_SPREADSHEET_CELLS;
  let extractedTextChars = 0;
  let truncatedText = false;
  let reachedSectionLimit = false;
  let reachedCellLimit = false;

  if (requestedSheetNames.length > sheetNames.length) {
    warnings.push({
      code: "sheet_limit_reached",
      message: `Only the first ${MAX_SPREADSHEET_SHEETS} worksheets were parsed.`,
      metadata: { totalSheets: requestedSheetNames.length, parsedSheets: sheetNames.length },
    });
  }

  for (let sheetIndex = 0; sheetIndex < sheetNames.length; sheetIndex += 1) {
    assertNotAborted(input.signal);
    if (remainingCells <= 0 || truncatedText || reachedSectionLimit) break;

    const sheetName = sheetNames[sheetIndex];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const allCells = collectCells(sheet);
    const cells = allCells.slice(0, remainingCells);
    if (allCells.length > cells.length) reachedCellLimit = true;
    remainingCells -= cells.length;

    const groups = groupCells(cells);
    for (const group of groups) {
      if (sections.length >= MAX_SPREADSHEET_SECTIONS) {
        reachedSectionLimit = true;
        break;
      }
      assertNotAborted(input.signal);
      const section = rangeGroupToSection(sheetName, sheetIndex, group);
      if (!section) continue;

      const remainingText = textLimit - extractedTextChars;
      if (remainingText <= 0) {
        truncatedText = true;
        break;
      }
      if (section.text.length > remainingText) {
        section.text = section.text.slice(0, remainingText);
        truncatedText = true;
      }
      extractedTextChars += section.text.length;
      sections.push(section);
      if (truncatedText) break;
    }
  }

  if (reachedCellLimit) {
    warnings.push({
      code: "cell_limit_reached",
      message: `Only the first ${MAX_SPREADSHEET_CELLS.toLocaleString()} populated cells were parsed.`,
      metadata: { maxCells: MAX_SPREADSHEET_CELLS },
    });
  }
  if (reachedSectionLimit) {
    warnings.push({
      code: "section_limit_reached",
      message: `Only the first ${MAX_SPREADSHEET_SECTIONS.toLocaleString()} spreadsheet ranges were parsed.`,
      metadata: { maxSections: MAX_SPREADSHEET_SECTIONS },
    });
  }
  if (truncatedText) {
    warnings.push({
      code: "extracted_text_truncated",
      message: `Extracted spreadsheet text was truncated at ${textLimit.toLocaleString()} characters.`,
      metadata: { maxExtractedTextChars: textLimit },
    });
  }
  if (sections.length === 0) warnings.push(createNoTextWarning());

  return createParsedDocument({
    format,
    sections,
    warnings,
    status: warnings.length > 0 && sections.length > 0 ? "partially_parsed" : undefined,
    metadata: {
      sheetCount: requestedSheetNames.length,
      parsedSheetCount: sheetNames.length,
      populatedCellCount: MAX_SPREADSHEET_CELLS - remainingCells,
    },
  });
}

function collectCells(sheet: XLSX.WorkSheet): SpreadsheetCell[] {
  const cells: SpreadsheetCell[] = [];
  for (const address of Object.keys(sheet)) {
    if (address.startsWith("!") || !/^[A-Z]+[1-9]\d*$/.test(address)) continue;
    const cell = sheet[address];
    if (!isCellObject(cell) || isEmptyCell(cell)) continue;

    const coordinate = XLSX.utils.decode_cell(address);
    if (!Number.isSafeInteger(coordinate.r) || !Number.isSafeInteger(coordinate.c) || coordinate.r < 0 || coordinate.c < 0) continue;
    cells.push({ address, row: coordinate.r, column: coordinate.c, cell });
  }
  return cells.sort((left, right) => left.row - right.row || left.column - right.column || left.address.localeCompare(right.address));
}

function groupCells(cells: SpreadsheetCell[]) {
  const groups = new Map<string, RangeGroup>();
  for (const cell of cells) {
    const rowBlock = Math.floor(cell.row / SPREADSHEET_RANGE_ROWS);
    const columnBlock = Math.floor(cell.column / SPREADSHEET_RANGE_COLUMNS);
    const key = `${rowBlock}:${columnBlock}`;
    const existing = groups.get(key);
    if (existing) {
      existing.cells.push(cell);
    } else {
      groups.set(key, { rowBlock, columnBlock, cells: [cell] });
    }
  }
  return [...groups.values()].sort((left, right) => left.rowBlock - right.rowBlock || left.columnBlock - right.columnBlock);
}

function rangeGroupToSection(sheetName: string, sheetIndex: number, group: RangeGroup): ParsedDocumentSection | undefined {
  const startRow = group.rowBlock * SPREADSHEET_RANGE_ROWS;
  const startColumn = group.columnBlock * SPREADSHEET_RANGE_COLUMNS;
  const endRow = startRow + SPREADSHEET_RANGE_ROWS - 1;
  const endColumn = startColumn + SPREADSHEET_RANGE_COLUMNS - 1;
  const range = XLSX.utils.encode_range({ s: { r: startRow, c: startColumn }, e: { r: endRow, c: endColumn } });
  const cells = new Map(group.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
  const rows: string[] = [];

  for (let row = startRow; row <= endRow; row += 1) {
    const values: string[] = [];
    let rowHasContent = false;
    for (let column = startColumn; column <= endColumn; column += 1) {
      const cell = cells.get(`${row}:${column}`);
      const value = cell ? cellText(cell.cell) : "";
      values.push(value);
      if (value) rowHasContent = true;
    }
    if (rowHasContent) rows.push(`${XLSX.utils.encode_cell({ r: row, c: startColumn })}\t${values.join("\t").replace(/\t+$/, "")}`);
  }

  const text = rows.join("\n").trim();
  if (!text) return undefined;
  const sectionKey = `sheet-${sheetName}!${range}`;
  return {
    sectionKey,
    kind: "sheet_range",
    text,
    metadata: {
      origin: "document_text",
      sheetName,
      sheetIndex: sheetIndex + 1,
      range,
      startRow: startRow + 1,
      endRow: endRow + 1,
      startColumn: startColumn + 1,
      endColumn: endColumn + 1,
    },
  };
}

function cellText(cell: XLSX.CellObject) {
  if (cell.t === "e") return String(cell.w ?? cell.v ?? "#ERROR!").replace(/\r\n?/g, " ");
  return String(cell.w ?? cell.v ?? "").replace(/\r\n?/g, " ");
}

function isCellObject(value: unknown): value is XLSX.CellObject {
  return Boolean(value) && typeof value === "object" && "t" in (value as object);
}

function isEmptyCell(cell: XLSX.CellObject) {
  return cell.t === "z" || (cell.v === undefined && cell.w === undefined);
}

function spreadsheetParseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown spreadsheet parsing failure.";
  if (/password|encrypt|protected/i.test(message)) {
    return new DocumentParseError({
      code: "password_protected",
      message: "Password-protected spreadsheets are not supported.",
      cause: error,
    });
  }
  return new DocumentParseError({
    code: "corrupted",
    message: "The spreadsheet file could not be parsed.",
    cause: error,
  });
}
